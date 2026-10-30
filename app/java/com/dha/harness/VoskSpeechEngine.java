package com.dha.harness;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;

import org.json.JSONObject;
import org.vosk.Model;
import org.vosk.Recognizer;
import org.vosk.android.RecognitionListener;
import org.vosk.android.SpeechService;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.Enumeration;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;

/** Bundled Chinese speech recognition, independent of the phone's speech services. */
final class VoskSpeechEngine {
    interface Listener {
        void onStatus(String text);
        void onPartial(String text);
        void onResult(String text);
        void onError(String text);
    }

    private static final String ASSET = "vosk-model-small-cn.zip";
    private static final long ASSET_BYTES = 43_899_979L;
    private static final String MODEL_DIR = "vosk-model-small-cn";
    private static final String MODEL_READY = ".ready-small-cn-0.22";
    private static final float SAMPLE_RATE = 16000.0f;
    private static final int LISTEN_TIMEOUT_MS = 20000;

    private final Context context;
    private final Listener listener;
    private final Handler main = new Handler(Looper.getMainLooper());

    private Model model;
    private Recognizer recognizer;
    private SpeechService speech;
    private boolean loading;
    private boolean active;
    private boolean pending;
    private boolean released;

    VoskSpeechEngine(Context context, Listener listener) {
        this.context = context.getApplicationContext();
        this.listener = listener;
    }

    void start() {
        if (released) return;
        pending = true;
        if (speech != null) {
            startSpeech();
        } else {
            loadModel();
        }
    }

    void stop() {
        pending = false;
        if (active && speech != null) {
            speech.stop();
        }
    }

    void cancel() {
        pending = false;
        active = false;
        if (speech != null) speech.cancel();
    }

    void close() {
        released = true;
        pending = false;
        active = false;
        if (speech != null) {
            speech.shutdown();
            speech = null;
        }
        if (recognizer != null) {
            recognizer.close();
            recognizer = null;
        }
        if (model != null) {
            model.close();
            model = null;
        }
    }

    private void loadModel() {
        if (loading || model != null) return;
        loading = true;
        App.log("offline voice: loading bundled model");
        listener.onStatus("正在准备离线语音");
        Thread loader = new Thread(() -> {
            Model loadedModel = null;
            Recognizer loadedRecognizer = null;
            SpeechService loadedSpeech = null;
            try {
                File directory = ensureModel();
                App.log("offline voice: model files=" + countFiles(directory));
                loadedModel = new Model(directory.getAbsolutePath());
                loadedRecognizer = new Recognizer(loadedModel, SAMPLE_RATE);
                loadedRecognizer.setWords(true);
                loadedSpeech = new SpeechService(loadedRecognizer, SAMPLE_RATE);
            } catch (Throwable error) {
                App.log("offline voice init failed: " + error);
            }
            Model finalModel = loadedModel;
            Recognizer finalRecognizer = loadedRecognizer;
            SpeechService finalSpeech = loadedSpeech;
            main.post(() -> {
                loading = false;
                if (released || finalSpeech == null) {
                    if (finalSpeech != null) finalSpeech.shutdown();
                    if (finalRecognizer != null) finalRecognizer.close();
                    if (finalModel != null) finalModel.close();
                    if (!released) listener.onError("离线语音初始化失败");
                    return;
                }
                model = finalModel;
                recognizer = finalRecognizer;
                speech = finalSpeech;
                App.log("offline voice: ready");
                listener.onStatus("离线语音已就绪");
                if (pending) startSpeech();
            });
        }, "vosk-model-loader");
        loader.setDaemon(true);
        loader.start();
    }

    private void startSpeech() {
        if (released || active || speech == null) return;
        pending = false;
        active = true;
        boolean started = speech.startListening(new VoskListener(), LISTEN_TIMEOUT_MS);
        if (!started) {
            active = false;
            listener.onError("麦克风正忙，请稍后重试");
            return;
        }
        listener.onStatus("正在听你说");
    }

    private final class VoskListener implements RecognitionListener {
        private boolean delivered;
        private String lastPartial = "";

        @Override
        public void onPartialResult(String hypothesis) {
            if (released) return;
            String text = field(hypothesis, "partial");
            if (!text.isEmpty()) {
                lastPartial = text;
                listener.onPartial(text);
            }
        }

        @Override
        public void onResult(String hypothesis) {
            if (released) return;
            App.log("offline voice: result " + hypothesis);
            deliver(field(hypothesis, "text"));
        }

        @Override
        public void onFinalResult(String hypothesis) {
            if (released) return;
            App.log("offline voice: final " + hypothesis);
            deliver(field(hypothesis, "text"));
            if (!delivered && !lastPartial.isEmpty()) deliver(lastPartial);
            if (!delivered && !released) listener.onError("没有识别到内容，请靠近麦克风后再试");
            active = false;
        }

        @Override
        public void onError(Exception error) {
            if (released) return;
            active = false;
            pending = false;
            App.log("offline voice error: " + error);
            listener.onError("离线语音识别失败");
        }

        @Override
        public void onTimeout() {
            if (released) return;
            active = false;
            pending = false;
            if (!delivered) listener.onError("没有识别到内容，请靠近麦克风后再试");
        }

        private void deliver(String text) {
            if (delivered || text == null || text.isEmpty()) return;
            delivered = true;
            active = false;
            listener.onResult(text);
            if (speech != null) speech.stop();
        }
    }

    private String field(String json, String name) {
        if (json == null || json.isEmpty()) return "";
        try {
            return new JSONObject(json).optString(name, "").trim();
        } catch (Throwable ignored) {
            return "";
        }
    }

    private File ensureModel() throws IOException {
        File base = new File(context.getFilesDir(), "voice");
        File directory = new File(base, MODEL_DIR);
        File ready = new File(directory, MODEL_READY);
        if (ready.isFile() && validModel(directory)) return directory;

        deleteRecursively(base);
        if (!base.mkdirs() && !base.isDirectory()) {
            throw new IOException("无法创建语音模型目录");
        }

        File archive = new File(base, "model.zip.tmp");
        try (InputStream input = new BufferedInputStream(context.getAssets().open(ASSET));
             BufferedOutputStream output = new BufferedOutputStream(new FileOutputStream(archive))) {
            byte[] buffer = new byte[64 * 1024];
            int count;
            while ((count = input.read(buffer)) != -1) {
                output.write(buffer, 0, count);
            }
        }
        if (archive.length() != ASSET_BYTES) {
            throw new IOException("语音模型资源不完整（" + archive.length() + " 字节）");
        }

        String basePath = base.getCanonicalPath() + File.separator;
        try (ZipFile zip = new ZipFile(archive)) {
            byte[] buffer = new byte[64 * 1024];
            Enumeration<? extends ZipEntry> entries = zip.entries();
            while (entries.hasMoreElements()) {
                ZipEntry entry = entries.nextElement();
                String name = entry.getName();
                if (name.startsWith("__MACOSX/") || name.endsWith(".DS_Store")) continue;
                File output = new File(base, name);
                if (!output.getCanonicalPath().startsWith(basePath)) {
                    throw new IOException("语音模型包含无效路径");
                }
                if (entry.isDirectory()) {
                    if (!output.mkdirs() && !output.isDirectory()) {
                        throw new IOException("无法创建语音模型子目录");
                    }
                    continue;
                }
                File parent = output.getParentFile();
                if (parent != null && !parent.mkdirs() && !parent.isDirectory()) {
                    throw new IOException("无法创建语音模型目录");
                }
                try (BufferedOutputStream out = new BufferedOutputStream(
                        new FileOutputStream(output));
                     InputStream entryInput = new BufferedInputStream(zip.getInputStream(entry))) {
                    int count;
                    while ((count = entryInput.read(buffer)) != -1) {
                        out.write(buffer, 0, count);
                    }
                }
            }
        }
        archive.delete();
        if (!validModel(directory)) {
            throw new IOException("语音模型解包不完整（" + countFiles(directory) + " 个文件）");
        }
        if (!ready.createNewFile() && !ready.isFile()) {
            throw new IOException("无法完成语音模型安装");
        }
        App.log("offline voice: model unpacked, files=" + countFiles(directory));
        return directory;
    }

    private boolean validModel(File directory) {
        return new File(directory, "conf/model.conf").isFile()
                && new File(directory, "am/final.mdl").isFile()
                && new File(directory, "graph/HCLr.fst").isFile();
    }

    private int countFiles(File directory) {
        if (directory == null || !directory.isDirectory()) return 0;
        int count = 0;
        File[] files = directory.listFiles();
        if (files == null) return 0;
        for (File file : files) {
            count += file.isDirectory() ? countFiles(file) : 1;
        }
        return count;
    }

    private void deleteRecursively(File file) {
        if (file == null || !file.exists()) return;
        File[] children = file.listFiles();
        if (children != null) {
            for (File child : children) deleteRecursively(child);
        }
        file.delete();
    }
}
