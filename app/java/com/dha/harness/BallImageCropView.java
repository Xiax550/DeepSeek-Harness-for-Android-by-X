package com.dha.harness;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Matrix;
import android.graphics.Paint;
import android.graphics.Rect;
import android.graphics.RectF;
import android.view.MotionEvent;
import android.view.ScaleGestureDetector;
import android.view.View;

/** A square, pan-and-zoom crop surface for the floating ball's custom image. */
final class BallImageCropView extends View {
    private final Paint imagePaint = new Paint(
            Paint.ANTI_ALIAS_FLAG | Paint.FILTER_BITMAP_FLAG | Paint.DITHER_FLAG);
    private final Paint checkerPaint = new Paint();
    private final Paint gridPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint borderPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Matrix drawMatrix = new Matrix();
    private final Matrix inverse = new Matrix();
    private final RectF viewRect = new RectF();
    private final RectF sourceRect = new RectF();
    private final ScaleGestureDetector scaleDetector;

    private Bitmap bitmap;
    private float scale = 1f;
    private float minScale = 1f;
    private float maxScale = 1f;
    private float offsetX;
    private float offsetY;
    private float lastX;
    private float lastY;

    BallImageCropView(Context context) {
        super(context);
        checkerPaint.setColor(Color.rgb(45, 48, 54));
        gridPaint.setColor(0x66FFFFFF);
        gridPaint.setStyle(Paint.Style.STROKE);
        gridPaint.setStrokeWidth(dp(1));
        borderPaint.setColor(0xCCFFFFFF);
        borderPaint.setStyle(Paint.Style.STROKE);
        borderPaint.setStrokeWidth(dp(2));
        scaleDetector = new ScaleGestureDetector(context,
                new ScaleGestureDetector.SimpleOnScaleGestureListener() {
                    @Override
                    public boolean onScale(ScaleGestureDetector detector) {
                        zoomBy(detector.getScaleFactor(), detector.getFocusX(), detector.getFocusY());
                        return true;
                    }
                });
        setBackgroundColor(Color.rgb(27, 29, 34));
    }

    void setBitmap(Bitmap value) {
        bitmap = value;
        configureBitmap();
        invalidate();
    }

    Bitmap cropSquare(int outputSize) {
        if (bitmap == null || bitmap.isRecycled() || getWidth() <= 0 || getHeight() <= 0) {
            return null;
        }
        if (!drawMatrix.invert(inverse)) return null;
        viewRect.set(0, 0, getWidth(), getHeight());
        sourceRect.set(viewRect);
        inverse.mapRect(sourceRect, viewRect);
        int left = Math.max(0, Math.round(sourceRect.left));
        int top = Math.max(0, Math.round(sourceRect.top));
        int right = Math.min(bitmap.getWidth(), Math.round(sourceRect.right));
        int bottom = Math.min(bitmap.getHeight(), Math.round(sourceRect.bottom));
        if (right <= left || bottom <= top) return null;

        int size = Math.max(128, outputSize);
        Bitmap output = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(output);
        canvas.drawBitmap(bitmap, new Rect(left, top, right, bottom),
                new Rect(0, 0, size, size), imagePaint);
        return output;
    }

    @Override
    protected void onMeasure(int widthMeasureSpec, int heightMeasureSpec) {
        int width = MeasureSpec.getSize(widthMeasureSpec);
        int height = MeasureSpec.getSize(heightMeasureSpec);
        int widthMode = MeasureSpec.getMode(widthMeasureSpec);
        int heightMode = MeasureSpec.getMode(heightMeasureSpec);
        int desired = widthMode == MeasureSpec.UNSPECIFIED ? dp(300) : width;
        if (heightMode != MeasureSpec.UNSPECIFIED) desired = Math.min(desired, height);
        desired = Math.min(desired, dp(360));
        desired = Math.max(desired, dp(180));
        setMeasuredDimension(desired, desired);
    }

    @Override
    protected void onSizeChanged(int width, int height, int oldWidth, int oldHeight) {
        super.onSizeChanged(width, height, oldWidth, oldHeight);
        configureBitmap();
    }

    @Override
    protected void onDraw(Canvas canvas) {
        super.onDraw(canvas);
        drawCheckerboard(canvas);
        if (bitmap == null || bitmap.isRecycled()) return;
        canvas.drawBitmap(bitmap, drawMatrix, imagePaint);

        float thirdX = getWidth() / 3f;
        float thirdY = getHeight() / 3f;
        canvas.drawLine(thirdX, 0, thirdX, getHeight(), gridPaint);
        canvas.drawLine(thirdX * 2, 0, thirdX * 2, getHeight(), gridPaint);
        canvas.drawLine(0, thirdY, getWidth(), thirdY, gridPaint);
        canvas.drawLine(0, thirdY * 2, getWidth(), thirdY * 2, gridPaint);
        canvas.drawRect(dp(1), dp(1), getWidth() - dp(1), getHeight() - dp(1), borderPaint);
    }

    @Override
    public boolean onTouchEvent(MotionEvent event) {
        if (bitmap == null) return false;
        getParent().requestDisallowInterceptTouchEvent(true);
        scaleDetector.onTouchEvent(event);
        switch (event.getActionMasked()) {
            case MotionEvent.ACTION_DOWN:
                lastX = event.getX();
                lastY = event.getY();
                return true;
            case MotionEvent.ACTION_POINTER_DOWN:
                lastX = event.getX();
                lastY = event.getY();
                return true;
            case MotionEvent.ACTION_MOVE:
                if (!scaleDetector.isInProgress() && event.getPointerCount() == 1) {
                    offsetX += event.getX() - lastX;
                    offsetY += event.getY() - lastY;
                    lastX = event.getX();
                    lastY = event.getY();
                    clampOffsets();
                    updateMatrix();
                    invalidate();
                }
                return true;
            case MotionEvent.ACTION_UP:
            case MotionEvent.ACTION_CANCEL:
                performClick();
                return true;
            default:
                return true;
        }
    }

    @Override
    public boolean performClick() {
        super.performClick();
        return true;
    }

    private void configureBitmap() {
        if (bitmap == null || bitmap.isRecycled() || getWidth() <= 0 || getHeight() <= 0) return;
        minScale = Math.max((float) getWidth() / bitmap.getWidth(),
                (float) getHeight() / bitmap.getHeight());
        maxScale = minScale * 6f;
        scale = minScale;
        offsetX = (getWidth() - bitmap.getWidth() * scale) / 2f;
        offsetY = (getHeight() - bitmap.getHeight() * scale) / 2f;
        clampOffsets();
        updateMatrix();
    }

    private void zoomBy(float factor, float focusX, float focusY) {
        if (bitmap == null || bitmap.isRecycled()) return;
        float next = Math.max(minScale, Math.min(maxScale, scale * factor));
        if (Math.abs(next - scale) < 0.0001f) return;
        float ratio = next / scale;
        offsetX = focusX - (focusX - offsetX) * ratio;
        offsetY = focusY - (focusY - offsetY) * ratio;
        scale = next;
        clampOffsets();
        updateMatrix();
        invalidate();
    }

    private void clampOffsets() {
        if (bitmap == null) return;
        float scaledWidth = bitmap.getWidth() * scale;
        float scaledHeight = bitmap.getHeight() * scale;
        if (scaledWidth <= getWidth()) {
            offsetX = (getWidth() - scaledWidth) / 2f;
        } else {
            offsetX = Math.max(getWidth() - scaledWidth, Math.min(0, offsetX));
        }
        if (scaledHeight <= getHeight()) {
            offsetY = (getHeight() - scaledHeight) / 2f;
        } else {
            offsetY = Math.max(getHeight() - scaledHeight, Math.min(0, offsetY));
        }
    }

    private void updateMatrix() {
        drawMatrix.reset();
        drawMatrix.setScale(scale, scale);
        drawMatrix.postTranslate(offsetX, offsetY);
    }

    private void drawCheckerboard(Canvas canvas) {
        int cell = dp(12);
        for (int y = 0; y < getHeight(); y += cell) {
            for (int x = 0; x < getWidth(); x += cell) {
                checkerPaint.setColor((((x / cell) + (y / cell)) & 1) == 0
                        ? Color.rgb(45, 48, 54) : Color.rgb(34, 36, 41));
                canvas.drawRect(x, y, Math.min(x + cell, getWidth()),
                        Math.min(y + cell, getHeight()), checkerPaint);
            }
        }
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }
}
