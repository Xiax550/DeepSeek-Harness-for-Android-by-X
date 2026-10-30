package com.dha.harness;

import org.json.JSONObject;

/**
 * Small, always-on DOM adjustments to the harness page.
 *
 * Kept deliberately separate from {@link Appearance}. Appearance rewrites the harness's
 * design-token variables -- that is a deep intervention, it once took the renderer process
 * down, and it stays opt-in. This class does only a few narrow, additive things, each of which
 * can fail without affecting anything else:
 *
 *   1. A 粘贴 (paste) button next to password/secret inputs. API keys are long and cannot be
 *      retyped from memory; the harness's own field offers only a long-press menu.
 *   2. Hiding the 快捷键 (keyboard shortcuts) row in 通用设置. A phone has no physical
 *      keyboard, so that settings row is dead weight.
 *   3. Turning generated image/video file links in assistant replies into inline media.
 *
 * The insertion is idempotent: a MutationObserver watches for new password inputs, and each
 * button is tagged so it is never added twice. Every failure path is contained, so a change
 * in the harness DOM degrades to "no button" rather than to a broken page.
 */
final class PageTools {

    private PageTools() {
    }

    /**
     * Preference: hide the keyboard-shortcuts row.
     *
     * OFF by default. The first two attempts at this were both wrong and the second one cost
     * more than it was worth: matching an element's whole textContent never matched the row,
     * and the follow-up ancestor walk could reach a wrapper that also contains UI the app
     * needs (the user reported settings becoming unreachable). Hiding arbitrary subtrees by
     * walking up from a text node is too blunt to be on by default, so it is opt-in and
     * documented as experimental.
     */
    static final String PREF_HIDE_SHORTCUTS = "hideShortcutsRow";

    /** Preference: inject the paste buttons. On by default (this one is verified). */
    static final String PREF_PASTE_BUTTON = "pasteButtonEnabled";

    /**
     * Preference: hide the 打开配置文件 action.
     *
     * OFF by default for the same reason as {@link #PREF_HIDE_SHORTCUTS}: the same ancestor
     * walk is what removes it.
     */
    static final String PREF_HIDE_CONFIG = "hideConfigFileAction";

    static boolean hideShortcuts() {
        // Default off: the paste button is the only injection verified on a device, and an
        // over-eager hide already cost the user a working settings screen once.
        return App.i().prefs.getBoolean(PREF_HIDE_SHORTCUTS, false);
    }

    static boolean pasteButton() {
        // Default off while the "settings became unreachable" regression is being chased:
        // the injection is the prime suspect and must be excludable with one flag.
        return App.i().prefs.getBoolean(PREF_PASTE_BUTTON, false);
    }

    static boolean hideConfigFile() {
        return true;
    }

    static void setHideShortcuts(boolean value) {
        App.i().prefs.edit().putBoolean(PREF_HIDE_SHORTCUTS, value).apply();
    }

    static void setPasteButton(boolean value) {
        App.i().prefs.edit().putBoolean(PREF_PASTE_BUTTON, value).apply();
    }

    static void setHideConfigFile(boolean value) {
        App.i().prefs.edit().putBoolean(PREF_HIDE_CONFIG, value).apply();
    }

    static String script() {
        JSONObject config = new JSONObject();
        try {
            config.put("shortcuts", hideShortcuts());
            config.put("paste", pasteButton());
            config.put("hideConfig", true);
        } catch (Throwable ignored) {
            // JSONObject.put only rejects non-finite numbers; nothing here can fail.
        }
        return SCRIPT_HEAD + config + SCRIPT_TAIL;
    }

    private static final String SCRIPT_HEAD = "(function(){try{var C=";

    private static final String SCRIPT_TAIL =
            ";"
            + "if(window.__lfyPageTools&&window.__lfyPageTools.dispose)window.__lfyPageTools.dispose();"
            /* The mobile drawer patch historically matched every class containing
               "_frame". Image messages use the same suffix and inherited a
               three-column grid whose outer tracks were zero, which made an
               otherwise loaded <img> compute to width:0. Scope the repair to
               the attachment frame's stable data-variant hook. */
            + "var imageFrameFix=document.getElementById('lfy-image-frame-grid');"
            + "if(!imageFrameFix){imageFrameFix=document.createElement('style');"
            + "imageFrameFix.id='lfy-image-frame-grid';document.head.appendChild(imageFrameFix);}"
            + "imageFrameFix.textContent='button[class*=\"_frame\"][data-variant]{grid-template-columns:none!important}';"
            /* Generated media commonly arrives as a normal Markdown link to a PNG/MP4.
               Upstream renders attachment image blocks; this covers model-returned file
               URLs and turns them into bounded, playable inline media. */
            + "var mediaStyle=document.getElementById('lfy-media-preview-style');"
            + "if(!mediaStyle){mediaStyle=document.createElement('style');"
            + "mediaStyle.id='lfy-media-preview-style';document.head.appendChild(mediaStyle);}"
            + "mediaStyle.textContent='.lfy-media-preview{margin:8px 0;max-width:min(100%,720px);}"
            + ".lfy-media-preview img,.lfy-media-preview video{display:block;width:auto;max-width:100%;"
            + "max-height:min(62vh,520px);border-radius:8px;background:rgba(0,0,0,.06)}';"
            + "var mediaPreviews=[];"
            + "function mediaKind(value){"
            + "var text=String(value||'').trim();"
            + "if(/^data:image\\/(?:png|jpe?g|webp|gif|avif);/i.test(text))return 'image';"
            + "if(/^data:video\\/(?:mp4|webm|quicktime);/i.test(text))return 'video';"
            + "try{text=decodeURIComponent(text);}catch(e){}"
            + "var path=text.split(/[?#]/)[0]||'';"
            + "if(/\\.(?:png|jpe?g|webp|gif|avif)$/i.test(path))return 'image';"
            + "if(/\\.(?:mp4|webm|mov|m4v)$/i.test(path))return 'video';"
            + "return '';}"
            + "function mediaUrl(value){"
            + "var text=String(value||'').trim();"
            + "if(/^(?:https?:|data:|blob:)/i.test(text))return text;"
            + "var path=text;"
            + "try{path=decodeURIComponent(text.split(/[?#]/)[0]||text);}catch(e){}"
            + "if(/^(?:\\/|[A-Za-z]:[\\\\/])/.test(path)){"
            + "try{return new URL('api/file?path='+encodeURIComponent(path),document.baseURI).href;}catch(e){}}"
            + "if(/^[a-z][a-z0-9+.-]*:/i.test(text))return '';"
            + "try{return new URL(text,document.baseURI).href;}catch(e){return text;}}"
            + "function addMediaPreview(anchor){"
            + "if(!anchor||anchor.dataset.lfyMedia)return;"
            + "var raw=anchor.getAttribute('href')||'';"
            + "var kind=mediaKind(raw);if(!kind)return;"
            + "var host=anchor.closest('[data-chat-flow-kind=\"response\"],[data-chat-group-part=\"response\"],[data-slot=\"conversation.chat.node\"]');"
            + "if(!host||anchor.closest('pre,code,.lfy-media-preview'))return;"
            + "var src=mediaUrl(raw);if(!src)return;"
            + "var box=document.createElement('div');box.className='lfy-media-preview';"
            + "if(kind==='image'){"
            + "var img=document.createElement('img');img.src=src;img.loading='lazy';"
            + "img.alt=(anchor.textContent||'生成图片').trim();"
            + "img.addEventListener('error',function(){try{box.remove();}catch(e){}},{once:true});"
            + "box.appendChild(img);"
            + "}else{"
            + "var video=document.createElement('video');video.controls=true;video.playsInline=true;"
            + "video.preload='metadata';video.src=src;"
            + "video.addEventListener('error',function(){try{box.remove();}catch(e){}},{once:true});"
            + "box.appendChild(video);}"
            + "anchor.dataset.lfyMedia=kind;"
            + "try{anchor.insertAdjacentElement('afterend',box);mediaPreviews.push(box);}catch(e){}"
            + "}"
            + "function scanMedia(root){"
            + "if(!root||!root.querySelectorAll)return;"
            + "var anchors=root.querySelectorAll('a[href]');"
            + "for(var i=0;i<anchors.length;i++)addMediaPreview(anchors[i]);}"
            // A pasted value is written with the native setter and a bubbling `input` event,
            // because React tracks the value on the node: assigning `.value` alone updates
            // the DOM but leaves the framework's state stale, so the value would look pasted
            // and then revert on the next render.
            + "function setNativeValue(node,text){"
            + "var d=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value');"
            + "var proto=window.HTMLTextAreaElement&&node instanceof window.HTMLTextAreaElement"
            + "?window.HTMLTextAreaElement.prototype:window.HTMLInputElement.prototype;"
            + "var desc=Object.getOwnPropertyDescriptor(proto,'value')||d;"
            + "if(desc&&desc.set)desc.set.call(node,text);else node.value=text;"
            + "node.dispatchEvent(new Event('input',{bubbles:true}));"
            + "node.dispatchEvent(new Event('change',{bubbles:true}));}"
            + "async function pasteInto(node){"
            + "try{"
            + "var text=await navigator.clipboard.readText();"
            + "if(!text||!text.trim()){flash(node,'剪贴板是空的');return;}"
            + "node.focus();setNativeValue(node,text.trim());flash(node,'已粘贴 '+text.trim().length+' 个字符');"
            + "}catch(e){flash(node,'读取剪贴板失败：请允许剪贴板访问');}}"
            + "function flash(node,message){"
            + "try{var tip=document.createElement('div');"
            + "tip.textContent=message;"
            + "tip.style.cssText='position:fixed;left:50%;bottom:72px;transform:translateX(-50%);"
            + "background:#000000cc;color:#fff;padding:6px 12px;border-radius:8px;font-size:12px;z-index:2147483647;pointer-events:none';"
            + "document.body.appendChild(tip);"
            + "setTimeout(function(){tip.remove();},1800);}catch(e){}}"
            /* Main-UI voice uses the APK's bundled offline recognizer. SenseVoice lives
               in the sandbox and needs a separate ~1 GB model, which is both slow and a
               poor fit for a phone's main composer. Capture the harness button before
               React sees it and hand the work to the native bridge instead. */
            + "function voiceButton(node){"
            + "var button=node&&node.closest?node.closest('button'):null;"
            + "if(!button||button.disabled)return null;"
            + "var label=(button.getAttribute('aria-label')||'')+' '+(button.title||'');"
            + "return /开始录音|重新录音|停止录音|语音输入|Start recording|Record again|Stop recording|Voice input/i.test(label)?button:null;}"
            + "var nativeVoiceState='idle';"
            + "function syncNativeVoiceButton(){"
            + "try{var buttons=document.querySelectorAll('button');"
            + "for(var i=0;i<buttons.length;i++){var button=buttons[i];"
            + "var label=(button.getAttribute('aria-label')||'')+' '+(button.title||'');"
            + "if(!/开始录音|重新录音|停止录音|语音输入|Start recording|Record again|Stop recording|Voice input/i.test(label))continue;"
            + "button.setAttribute('data-lfy-native-voice','1');"
            + "var wanted=nativeVoiceState==='listening'?'停止录音':'开始录音';"
            + "if(button.getAttribute('aria-label')!==wanted)button.setAttribute('aria-label',wanted);"
            + "}}catch(e){}}"
            + "function nativeVoiceClick(event){"
            + "if(!window.DshNativeVoice||typeof window.DshNativeVoice.toggle!=='function')return;"
            + "var button=voiceButton(event.target);"
            + "if(!button)return;"
            + "event.preventDefault();event.stopImmediatePropagation();"
            + "try{window.DshNativeVoice.toggle();}catch(e){flash(button,'语音输入启动失败');}}"
            + "window.__dshNativeVoiceState=function(state,text){"
            + "try{"
            + "nativeVoiceState=state;syncNativeVoiceButton();"
            + "var button=document.querySelector('button[data-lfy-native-voice=\"1\"]');"
            + "if(text&&state!=='partial')flash(button||document.body,text);"
            + "}catch(e){}};"
            + "window.__dshNativeVoiceResult=function(text){"
            + "try{"
            + "var value=String(text||'').trim();if(!value)return;"
            + "var box=document.querySelector('[role=\"textbox\"][contenteditable=\"true\"]')"
            + "||document.querySelector('[role=\"textbox\"]')||document.querySelector('textarea');"
            + "if(!box){try{navigator.clipboard.writeText(value);}catch(e){}"
            + "flash(document.body,'识别结果已复制');return;}"
            + "box.focus();"
            + "try{var data=new DataTransfer();data.setData('text/plain',value);"
            + "box.dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));"
            + "}catch(e){try{document.execCommand('insertText',false,value);}catch(ignored){}}"
            + "flash(box,'已写入语音');"
            + "}catch(e){}};"
            + "document.addEventListener('click',nativeVoiceClick,true);"
            /* A secret field is recognised by type=password or by an id/name/placeholder that
               mentions key/secret/token/password -- the harness renders some credential inputs
               as plain text. */
            + "function isSecret(node){"
            + "if(!node||node.tagName!=='INPUT')return false;"
            + "if(node.type==='password')return true;"
            + "if(node.dataset&&node.dataset.lfyPaste==='1')return true;"
            + "var hay=((node.getAttribute('id')||'')+' '+(node.getAttribute('name')||'')+' '"
            + "+(node.getAttribute('placeholder')||'')+' '+(node.getAttribute('aria-label')||'')).toLowerCase();"
            + "return /api[-_ ]?key|secret|token|password|apikey|密钥|口令/.test(hay);}"
            + "function addButton(node){"
            + "if(!C.paste)return;"
            + "if(!isSecret(node))return;"
            + "var id=++pasteSeq;"
            + "var button=document.createElement('button');"
            + "button.type='button';"
            + "button.textContent='粘贴';"
            + "button.setAttribute('data-lfy-paste-button','1');"
            /* Deliberately appended to <body> and positioned over the field, NOT inserted
               next to the input. An earlier version appended it into the field's own
               container, and React removed it on the next render because that container is
               React-managed -- the button appeared and then vanished, which is exactly what
               the user reported. Living outside the React tree, this one survives renders;
               the observer below re-adds it only if React drops the whole subtree. */
            + "button.style.cssText='position:fixed;z-index:2147483000;padding:5px 12px;"
            + "font-size:12px;line-height:1.2;border-radius:8px;border:1px solid rgba(127,127,127,.55);"
            + "background:rgba(127,127,127,.18);color:inherit;cursor:pointer;white-space:nowrap;"
            + "backdrop-filter:blur(2px)';"
            + "button.addEventListener('click',function(event){"
            + "event.preventDefault();event.stopPropagation();pasteInto(node);});"
            + "document.body.appendChild(button);"
            + "pasteTargets.push({input:node,button:button,seq:id});"
            + "positionAll();}"
            /* Track the field rather than its container, so the button follows the input
               through scrolling and re-layout. */
            + "function positionAll(){"
            + "for(var i=pasteTargets.length-1;i>=0;i--){"
            + "var entry=pasteTargets[i];"
            + "var node=entry.input;"
            + "if(!node||!node.isConnected){try{entry.button.remove();}catch(e){}"
            + "pasteTargets.splice(i,1);continue;}"
            + "var rect=node.getBoundingClientRect();"
            + "var visible=rect.width>40&&rect.height>10&&rect.bottom>0&&rect.top<window.innerHeight;"
            + "entry.button.style.display=visible?'block':'none';"
            + "if(!visible)continue;"
            // Sits inside the right edge of the field, vertically centred.
            + "var width=entry.button.offsetWidth||52;"
            + "entry.button.style.left=Math.max(4,(rect.right-width-6))+'px';"
            + "entry.button.style.top=Math.max(2,(rect.top+(rect.height-entry.button.offsetHeight)/2))+'px';}}"
            + "function scan(root){"
            + "if(!root)return;"
            + "if(root.querySelectorAll){"
            + "var inputs=root.querySelectorAll('input');"
            + "for(var i=0;i<inputs.length;i++)consider(inputs[i]);}"
            + "if(root.tagName==='INPUT')consider(root);}"
            /* Re-inject when React replaces the subtree, and re-position on any change. A
               full re-scan of the document is cheap here: the settings modal is small. */
            + "function consider(node){"
            + "if(!C.paste||!isSecret(node))return;"
            + "for(var i=0;i<pasteTargets.length;i++){"
            + "if(pasteTargets[i].input===node)return;}"
            + "addButton(node);}"
            /* Hiding the shortcuts row: the harness gives the settings rows no stable hook,
               so the row is found by its own title text and then removed. Matching only the
               exact label keeps this from hitting anything else that mentions 快捷键. */
            + "function hideShortcuts(){"
            + "if(!C.shortcuts)return;"
            + "hideByExactText('快捷键');}"
            /* The 打开配置文件 action cannot work on Android: the harness reaches
               dsh-native-command's openNativeTextFile(), whose Linux branch runs
               `xdg-open`, and a PRoot sandbox has neither that program nor a desktop.
               The control only ever produced 无法打开配置文件, so it is hidden.
               Matched on the button's own label; the wrapper is hidden rather than the
               button alone so no stray gap is left in the header row. */
            + "function hideConfig(){"
            + "if(!C.hideConfig)return;"
            + "hideByExactText('打开配置文件');}"
            /* Hide the settings row whose TITLE is exactly this label.
               Matching an element's whole textContent does not work: the row is
               <div class=...setting><div><div class=...settingTitle>快捷键</div>
               <p class=...settingDescription>…</p></div><button>…</button></div>, so the
               title's own div holds exactly the label while every ancestor holds the label
               plus the description -- an exact match on the title never reached the row, and
               an exact match on the row never matched. A TreeWalker finds the title text node
               directly, then climbs to the smallest ancestor that still looks like ONE row.

               The climb is where this got dangerous: "nearest ancestor with a button" walked
               straight past the row into wrappers that also contain UI the app needs, and
               hiding one of those left settings unreachable. It now stops as soon as an
               ancestor holds more than one button or more text than a row would, so only a
               leaf row can ever be hidden. */
            + "function hideByExactText(label){"
            + "var walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT,null);"
            + "var hits=[];"
            + "while(walker.nextNode()){"
            + "var node=walker.currentNode;"
            + "if(node.nodeValue&&node.nodeValue.trim()===label)hits.push(node.parentElement);}"
            + "for(var i=0;i<hits.length;i++){"
            + "var title=hits[i];"
            + "if(!title||title.dataset.lfyHidden==='1')continue;"
            + "var row=null;var cursor=title;"
            + "while(cursor&&cursor!==document.body){"
            + "var buttons=cursor.querySelectorAll?cursor.querySelectorAll('button').length:0;"
            + "var text=(cursor.textContent||'').trim();"
            // One row: a single control and a short caption. Anything bigger is a wrapper.
            + "if(buttons>1||text.length>80)break;"
            + "if(buttons===1)row=cursor;"
            + "cursor=cursor.parentElement;}"
            + "if(!row||row.dataset.lfyHidden==='1')continue;"
            + "row.dataset.lfyHidden='1';"
            + "row.style.display='none';}}"
            /* The Android back key: MainActivity calls window.__dshmBack and only moves the
               task to the background when the page answers anything other than "true".

               The harness reports its own modals in the DOM -- primitives' useModalLayer
               registers them as [role=dialog][aria-modal=true] and owns Escape through the
               document -- so the topmost such layer is detected and dismissed by sending
               Escape at it. Without this hook the page never answered and back always quit
               the app, even from inside an open settings panel. */
            + "function goBack(){"
            + "try{"
            + "var modals=document.querySelectorAll('[role=dialog][aria-modal=true],[role=menu]');"
            + "if(modals.length===0)return false;"
            + "var top=modals[modals.length-1];"
            + "if(!top)return false;"
            + "var target=top;"
            + "var active=document.activeElement;"
            + "if(active&&(top===active||top.contains(active)))target=active;"
            + "try{target.focus();}catch(e){}"
            + "var event=new KeyboardEvent('keydown',{key:'Escape',code:'Escape',keyCode:27,which:27,bubbles:true,cancelable:true});"
            + "target.dispatchEvent(event);"
            + "if(!event.defaultPrevented){"
            + "document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',code:'Escape',keyCode:27,which:27,bubbles:true,cancelable:true}));}"
            + "return true;"
            + "}catch(e){return false;}}"
            + "window.__dshmBack=goBack;"
            + "var observer=null;var scheduled=false;var pasteTargets=[];var pasteSeq=0;"
            + "function schedule(){"
            + "if(scheduled)return;scheduled=true;"
            + "requestAnimationFrame(function(){scheduled=false;try{scan(document);scanMedia(document);hideShortcuts();hideConfig();positionAll();syncNativeVoiceButton();}catch(e){}});}"
            + "if(document.body){"
            + "observer=new MutationObserver(schedule);"
            + "observer.observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['aria-label']});}"
            + "window.__lfyPageTools={dispose:function(){"
            + "if(observer){observer.disconnect();observer=null;}"
            + "document.removeEventListener('click',nativeVoiceClick,true);"
            + "var imageFrameFix=document.getElementById('lfy-image-frame-grid');if(imageFrameFix)imageFrameFix.remove();"
            + "var mediaStyle=document.getElementById('lfy-media-preview-style');if(mediaStyle)mediaStyle.remove();"
            + "for(var m=0;m<mediaPreviews.length;m++){try{mediaPreviews[m].remove();}catch(e){}}mediaPreviews=[];"
            + "var markedMedia=document.querySelectorAll('[data-lfy-media]');"
            + "for(var n=0;n<markedMedia.length;n++){try{delete markedMedia[n].dataset.lfyMedia;}catch(e){}}"
            + "try{if(window.__dshmBack===goBack)delete window.__dshmBack;}catch(e){}"
            + "try{var buttons=document.querySelectorAll('[data-lfy-paste-button=1]');"
            + "for(var i=0;i<buttons.length;i++)buttons[i].remove();"
            + "pasteTargets=[];"
            + "var hidden=document.querySelectorAll('[data-lfy-hidden=1]');"
            + "for(var k=0;k<hidden.length;k++){hidden[k].style.display='';delete hidden[k].dataset.lfyHidden;}}catch(e){}}};"
            + "scan(document);scanMedia(document);hideShortcuts();hideConfig();schedule();"
            + "return 'page-tools:'+(C.paste?'paste,':'')+(C.shortcuts?'hide-shortcuts,':'')+(C.hideConfig?'hide-config,':'')+'media';"
            + "}catch(e){return 'page-tools-error:'+String(e);}})()";
}
