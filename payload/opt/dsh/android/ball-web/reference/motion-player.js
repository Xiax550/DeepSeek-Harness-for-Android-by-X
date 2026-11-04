/* Deterministic whole-body frames, decoded once; no autonomous looping video. */
(function () {
  'use strict';
  function clamp(value) { return Math.max(0, Math.min(1, Number(value) || 0)); }
  function timeAt(clip, progress) {
    var knots = clip.knots, p = clamp(progress), seconds = knots[knots.length - 1][1];
    for (var i = 1; i < knots.length; i++) {
      if (p <= knots[i][0]) {
        var a = knots[i - 1], b = knots[i];
        var u = (p - a[0]) / (b[0] - a[0]), slopes = clip.tangents;
        seconds = slopes ? (2*u*u*u - 3*u*u + 1) * a[1]
          + (u*u*u - 2*u*u + u) * (b[0]-a[0]) * slopes[i-1]
          + (-2*u*u*u + 3*u*u) * b[1] + (u*u*u-u*u) * (b[0]-a[0]) * slopes[i]
          : a[1] + (b[1]-a[1]) * u;
        break;
      }
    }
    return seconds;
  }
  function positionAt(clip, progress) {
    return Math.max(clip.firstFrame || 0, Math.min(clip.frames - 1, timeAt(clip, progress) * clip.fps));
  }
  function frameAt(clip, progress) {
    return Math.round(positionAt(clip, progress));
  }
  async function create(base) {
    var spec = window.DHA_WHOLE_MOTION;
    if (!spec) throw new Error('Whole-body motion manifest missing');
    var atlases = {}, disposed = false, last = null;
    var buffer = document.createElement('canvas'); buffer.width = buffer.height = spec.size;
    var blend = buffer.getContext('2d');
    await Promise.all(Object.keys(spec.clips).map(async function (name) {
      atlases[name] = await Promise.all(spec.clips[name].files.map(function (file) {
        return new Promise(function (resolve, reject) {
          var img = new Image();
          img.onload = async function () {
            if (img.naturalWidth !== spec.size * spec.columns || img.naturalHeight !== spec.size * spec.rows)
              reject(new Error('Invalid whole-body atlas dimensions'));
            else {
              try {
                if (img.decode) await img.decode();
              } catch (error) { /* Some Android intercepted URLs reject decode after a valid load. */ }
              resolve(img);
            }
          };
          img.onerror = function () { reject(new Error('Missing whole-body atlas: ' + file)); };
          img.src = new URL('./motion/' + file, base);
        });
      }));
    }));
    return {
      draw: function (ctx, name, progress, width, height) {
        if (disposed || !spec.clips[name]) return false;
        var position = positionAt(spec.clips[name], progress), from = Math.floor(position), to = Math.ceil(position);
        var mix = position - from;
        function cell(target, index, w, h) {
          var offset = index % spec.framesPerAtlas;
          target.drawImage(atlases[name][Math.floor(index / spec.framesPerAtlas)],
            offset % spec.columns * spec.size, Math.floor(offset / spec.columns) * spec.size,
            spec.size, spec.size, 0, 0, w, h);
        }
        if (from === to || !blend) cell(ctx, from, width, height);
        else {
          // Mix adjacent 25-ms drawings in premultiplied RGBA. The additive
          // blend here is intentional: the two complementary weights sum to
          // one, avoiding transparent holes and opacity dips at their join.
          blend.clearRect(0, 0, spec.size, spec.size);
          blend.globalCompositeOperation = 'source-over'; blend.globalAlpha = 1 - mix;
          cell(blend, from, spec.size, spec.size);
          // Complementary premultiplied contributions must be added or the
          // translucent edge alpha dips between frames.
          blend.globalCompositeOperation = 'lighter'; blend.globalAlpha = mix;
          cell(blend, to, spec.size, spec.size);
          blend.globalAlpha = 1; blend.globalCompositeOperation = 'source-over';
          ctx.drawImage(buffer, 0, 0, width, height);
        }
        last = { clip: name, frame: Math.round(position), progress: clamp(progress),
          fromFrame: from, toFrame: to, mix: mix }; return true;
      },
      clear: function () { last = null; },
      info: function () { return last; },
      dispose: function () { disposed = true; atlases = {}; last = null; buffer.width = buffer.height = 0; blend = null; }
    };
  }
  window.WholeBodyMotion = { create: create, frameAt: frameAt, timeAt: timeAt, positionAt: positionAt };
})();
