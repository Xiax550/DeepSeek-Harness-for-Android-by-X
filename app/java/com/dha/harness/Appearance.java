package com.dha.harness;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONObject;

/**
 * Appearance control for the harness page.
 *
 * Why this lives on the Android side rather than in a skin plugin: the harness page paints
 * its palette from design-token CSS variables that it writes as INLINE styles on
 * {@code <body>} (see dsh-client-ui-layout's ThemePresenter). Inline styles outrank any
 * stylesheet, so the only reliable override is {@code setProperty(name, value, "important")}
 * from script, plus keeping the two attributes the rest of the page reads in sync:
 *
 *   data-ds-theme-source   on &lt;html&gt;   "light" | "dark" | "system"
 *   data-ds-dark-theme     on &lt;body&gt;   present means dark
 *
 * The ThemePresenter also re-applies on every theme change (and the harness has its own
 * light/dark switch inside 设置), so the override is re-asserted from a MutationObserver --
 * otherwise the user's choice would silently revert the first time the page re-themed.
 *
 * A custom background image cannot simply sit behind the page: the frame, sidebar and cards
 * all paint opaque surfaces of their own, so the image would be invisible. Instead the
 * overriding palette makes those surfaces translucent when an image is set, and the image is
 * layered on the page background. This is deliberately invasive and is documented as such.
 */
final class Appearance {

    static final String MODE_LIGHT = "light";
    static final String MODE_DARK = "dark";
    static final String MODE_SYSTEM = "system";

    private static final String KEY_MODE = "appearance_mode";
    private static final String KEY_IMAGE = "appearance_image";
    private static final String KEY_IMAGE_ALPHA = "appearance_image_alpha";
    private static final String KEY_ACCENT = "appearance_accent";
    /** Master switch. Off by default, because enabling it injects script into the page. */
    private static final String KEY_ENABLED = "appearance_enabled";

    /**
     * Whether the injected appearance override is active at all.
     *
     * Off by default. The override works by writing the harness's own design-token CSS
     * variables as {@code !important} inline styles and keeping a MutationObserver on the
     * two attributes the harness re-writes; that is invasive enough that a page change can
     * destabilise the WebView renderer, and a renderer crash takes the whole app with it.
     * Keeping it opt-in means an untouched install behaves exactly like upstream, and only a
     * user who asks for an override carries the risk.
     */
    static boolean isEnabled() {
        return prefs().getBoolean(KEY_ENABLED, false);
    }

    static void setEnabled(boolean enabled) {
        prefs().edit().putBoolean(KEY_ENABLED, enabled).apply();
    }

    /** Where the chosen background image is copied. App-private, so no permission is needed. */
    static final String IMAGE_FILE = "appearance_background";

    private Appearance() {
    }

    private static SharedPreferences prefs() {
        return App.i().prefs;
    }

    static String mode() {
        String mode = prefs().getString(KEY_MODE, MODE_LIGHT);
        if (MODE_LIGHT.equals(mode) || MODE_DARK.equals(mode) || MODE_SYSTEM.equals(mode)) {
            return mode;
        }
        return MODE_LIGHT;
    }

    static void setMode(String mode) {
        prefs().edit()
                .putString(KEY_MODE, mode)
                // The palette cache belongs to the previous choice. Keeping it
                // would make a light choice boot dark until the page reports.
                .remove("page_theme_dark")
                .remove("page_theme_background")
                .remove("page_theme_background_alpha")
                .apply();
    }

    /** Absolute path of the chosen background image, or null when none is set. */
    static String imagePath() {
        String name = prefs().getString(KEY_IMAGE, null);
        if (name == null || name.isEmpty()) return null;
        java.io.File file = new java.io.File(App.i().getFilesDir(), name);
        return file.isFile() ? file.getAbsolutePath() : null;
    }

    static void clearImage() {
        String name = prefs().getString(KEY_IMAGE, null);
        if (name != null && !name.isEmpty()) {
            //noinspection ResultOfMethodCallIgnored
            new java.io.File(App.i().getFilesDir(), name).delete();
        }
        prefs().edit().remove(KEY_IMAGE).apply();
    }

    static void setImageFile(String fileName) {
        prefs().edit().putString(KEY_IMAGE, fileName).apply();
    }

    /** 0..100: how strongly the image shows through the page surfaces. */
    static int imageAlpha() {
        return prefs().getInt(KEY_IMAGE_ALPHA, 55);
    }

    static void setImageAlpha(int alpha) {
        prefs().edit().putInt(KEY_IMAGE_ALPHA, Math.max(0, Math.min(100, alpha))).apply();
    }

    /** Accent override as {@code #rrggbb}, or null to keep the harness palette. */
    static String accent() {
        String value = prefs().getString(KEY_ACCENT, null);
        if (value == null || !value.matches("#[0-9a-fA-F]{6}")) return null;
        return value.toLowerCase();
    }

    static void setAccent(String value) {
        if (value == null) prefs().edit().remove(KEY_ACCENT).apply();
        else prefs().edit().putString(KEY_ACCENT, value).apply();
    }

    /**
     * The script that installs (or refreshes) the appearance override in the page.
     *
     * Returns a self-contained IIFE. It is idempotent: re-running it replaces the previous
     * override rather than stacking a second observer.
     */
    static String script() {
        JSONObject config = new JSONObject();
        try {
            config.put("mode", mode());
            // A hash of the file name, not the path: it only has to change when the picture
            // changes, and it keeps the URL free of filesystem detail.
            String image = imagePath();
            config.put("image", image == null ? JSONObject.NULL : image.hashCode());
            config.put("imageAlpha", imageAlpha());
            String accent = accent();
            config.put("accent", accent == null ? JSONObject.NULL : accent);
        } catch (Throwable ignored) {
            // JSONObject.put only throws on non-finite numbers; nothing here can.
        }
        return SCRIPT_HEAD + config + SCRIPT_TAIL;
    }

    private static final String SCRIPT_HEAD =
            "(function(){try{"
            + "var C=";
    private static final String SCRIPT_TAIL =
            ";"
            // Re-running replaces the previous install instead of stacking observers.
            + "if(window.__lfyAppearance&&window.__lfyAppearance.dispose)window.__lfyAppearance.dispose();"
            + "var root=document.documentElement,body=document.body;"
            + "if(!body)return 'no-body';"
            + "var LIGHT={"
            + "'--dsw-alias-bg-base':'#FFFFFFFF','--dsw-alias-bg-base-hover':'#F3F5F9FF',"
            + "'--dsw-alias-bg-base-active':'#E9EDF4FF','--dsw-alias-bg-elevated':'#FFFFFFFF',"
            + "'--dsw-alias-bg-mask':'#0B0E1414','--dsw-alias-border-l1':'#E6E9F0FF',"
            + "'--dsw-alias-border-l2':'#D8DDE8FF','--dsw-alias-border-l3':'#C7CEDDFF',"
            + "'--dsw-alias-label-primary':'#111726FF','--dsw-alias-label-secondary':'#4B5567FF',"
            + "'--dsw-alias-label-tertiary':'#7A8598FF','--dsw-alias-label-quaternary':'#A2ABBBFF',"
            + "'--dsw-specific-sidebar-fill':'#F5F7FBFF','--dsw-specific-card-fill':'#FFFFFFFF'};"
            + "var DARK={"
            + "'--dsw-alias-bg-base':'#16181DFF','--dsw-alias-bg-base-hover':'#1E2128FF',"
            + "'--dsw-alias-bg-base-active':'#262A33FF','--dsw-alias-bg-elevated':'#1E2128FF',"
            + "'--dsw-alias-bg-mask':'#00000066','--dsw-alias-border-l1':'#2C313BFF',"
            + "'--dsw-alias-border-l2':'#3A404CFF','--dsw-alias-border-l3':'#4A515FFF',"
            + "'--dsw-alias-label-primary':'#EDEFF4FF','--dsw-alias-label-secondary':'#AEB6C4FF',"
            + "'--dsw-alias-label-tertiary':'#848D9EFF','--dsw-alias-label-quaternary':'#5F6776FF',"
            + "'--dsw-specific-sidebar-fill':'#121419FF','--dsw-specific-card-fill':'#1B1E24FF'};"
            // Accent: the brand blue the harness already uses for primary actions.
            + "var ACCENT={"
            + "'--dsw-alias-brand-primary':'#4176E6FF','--dsw-alias-brand-primary-hover':'#5A89EAFF'};"
            + "var STYLE_ID='lfy-appearance-style';"
            + "var observer=null,sentDark=null;"
            + "function resolvedDark(){"
            + "if(C.mode==='dark')return true;"
            + "if(C.mode==='light')return false;"
            + "return !!(window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches);}"
            + "function palette(dark){"
            + "var base=Object.assign({},dark?DARK:LIGHT);"
            + "if(C.accent)Object.assign(base,ACCENT,{'--dsw-alias-brand-primary':C.accent});"
            // With a background image the big surfaces must go translucent or the image
            // is hidden behind them; the text colours stay as-is.
            + "if(C.image){"
            + "base['--dsw-alias-bg-base']=dark?'rgba(18,20,25,'+((1-C.imageAlpha/100)*0.85)+')'"
            + ":'rgba(255,255,255,'+((1-C.imageAlpha/100)*0.88)+')';"
            + "base['--dsw-specific-sidebar-fill']=dark?'rgba(16,18,22,'+((1-C.imageAlpha/100)*0.8)+')'"
            + ":'rgba(245,247,251,'+((1-C.imageAlpha/100)*0.82)+')';"
            + "base['--dsw-specific-card-fill']=dark?'rgba(27,30,36,'+((1-C.imageAlpha/100)*0.7)+')'"
            + ":'rgba(255,255,255,'+((1-C.imageAlpha/100)*0.78)+')';}"
            + "return base;}"
            // Inline styles are what the ThemePresenter writes, so an override has to be
            // !important; a stylesheet alone would lose to it.
            + "var painting=false;"
            // A hard bound as well as the re-entrancy flag: if some future page re-themes in a
            // loop, five paints per frame is cheap, but unbounded recursion takes the whole
            // renderer process down (SIGTRAP in Chrome_IOThread). Bailing out is always better
            // than a crash the user cannot recover from.
            + "var paintBudget=0;"
            + "function paint(){"
            // Re-entrancy guard. paint() writes inline styles, and the observer below
            // watches exactly those attributes -- without this flag a paint would schedule
            // another paint forever and take the renderer process down with it.
            + "if(painting)return;"
            + "if(paintBudget>200){return;}"
            + "painting=true;paintBudget++;"
            + "try{"
            + "var dark=resolvedDark();"
            + "var tokens=palette(dark);"
            + "for(var name in tokens)body.style.setProperty(name,tokens[name],'important');"
            + "root.style.setProperty('color-scheme',dark?'dark':'light','important');"
            + "root.setAttribute('data-ds-theme-source',C.mode==='system'?'system':(dark?'dark':'light'));"
            + "if(dark)body.setAttribute('data-ds-dark-theme','');else body.removeAttribute('data-ds-dark-theme');"
            + "var css='';"
            + "if(C.image){"
            // The image is served by the control bridge: a file:// url would be blocked
            // because the page's origin is http://127.0.0.1.
            + "var d=window.DshAndroid;"
            + "var url=(d&&d.base?d.base:'')+'/background?token='+encodeURIComponent(d&&d.token?d.token:'')+'&v='+C.image;"
            + "css+='html{background:transparent !important;}';"
            + "css+='body{background-image:url(\"'+url+'\") !important;"
            + "background-size:cover !important;background-position:center !important;"
            + "background-attachment:fixed !important;background-repeat:no-repeat !important;}';"
            + "css+='[class*=\"frame\"],[class*=\"Frame\"],[class*=\"centerCol\"],[class*=\"sidebarCol\"],"
            + "[class*=\"rightbarCol\"],[class*=\"panel\"],[class*=\"Panel\"],[class*=\"card\"],[class*=\"Card\"]"
            + "{background:transparent !important;}';"
            + "}else{"
            // Removing the image has to undo the transparency, or the page stays see-through.
            + "css+='body{background-image:none !important;background-attachment:scroll !important;}';"
            + "}"
            + "var node=document.getElementById(STYLE_ID);"
            + "if(!node){node=document.createElement('style');node.id=STYLE_ID;document.head.appendChild(node);}"
            + "if(node.textContent!==css)node.textContent=css;"
            + "report(dark);"
            + "}finally{painting=false;}}"
            // The app paints its window/bars from the page's palette; without this the
            // status bar keeps the phone's theme and clashes with a forced palette.
            + "function report(dark){"
            + "if(sentDark===dark)return;"
            + "var scrim=dark?'#12141AFF':'#FFFFFFFF';"
            + "try{"
            + "if(window.DshAndroid&&window.DshAndroid.base&&window.DshAndroid.token){"
            + "fetch(window.DshAndroid.base+'/theme',{method:'POST',"
            + "headers:{'Content-Type':'application/json','X-Dsh-Token':window.DshAndroid.token},"
            + "body:JSON.stringify({dark:dark,bg:scrim,alpha:1,opaque:true})})"
            + ".then(function(){sentDark=dark;}).catch(function(){});"
            + "}else{sentDark=dark;}"
            + "}catch(e){}}"
            // The harness re-applies its own tokens whenever its theme changes, so watch the
            // attributes it writes and re-assert ours afterwards.
            // Only the harness's own data-ds-* attributes are observed, deliberately NOT
            // `style`: paint() writes inline styles, so observing `style` would make every
            // paint re-trigger the observer. (That mistake crashed the renderer process --
            // unbounded recursion inside the WebView shows up as SIGTRAP in Chrome_IOThread.)
            + "function watch(){"
            + "if(observer)return;"
            + "observer=new MutationObserver(function(){scheduled();});"
            + "observer.observe(root,{attributes:true,attributeFilter:['data-ds-theme-source']});"
            + "observer.observe(body,{attributes:true,attributeFilter:['data-ds-dark-theme']});"
            + "if(window.matchMedia){"
            + "var m=window.matchMedia('(prefers-color-scheme: dark)');"
            + "if(m.addEventListener)m.addEventListener('change',function(){scheduled();});}}"
            // Called for every external trigger: a fresh budget, since each real theme change
            // is entitled to its own small allowance.
            + "function scheduled(){paintBudget=0;paint();}"
            + "window.__lfyAppearance={dispose:function(){"
            + "if(observer){observer.disconnect();observer=null;}"
            + "var n=document.getElementById(STYLE_ID);if(n)n.remove();"
            + "for(var name in Object.assign({},LIGHT,DARK,ACCENT))body.style.removeProperty(name);"
            + "root.style.removeProperty('color-scheme');"
            + "root.removeAttribute('data-ds-theme-source');"
            + "body.removeAttribute('data-ds-dark-theme');"
            + "sentDark=null;}};"
            + "paint();watch();"
            + "return 'ok:'+C.mode+(C.image?':image':'');"
            + "}catch(e){return 'error:'+String(e);}})()";
}
