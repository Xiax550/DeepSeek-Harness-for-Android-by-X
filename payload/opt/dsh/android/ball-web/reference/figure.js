/* Independent reference-art mesh. No previous character model or parts. */
(function () {
  'use strict';
  var VS = 'attribute vec2 p;attribute vec2 uv;varying vec2 v;void main(){v=uv;gl_Position=vec4(p.x/128.-1.,1.-p.y/128.,0.,1.);}';
  var FS = 'precision mediump float;uniform sampler2D tex;uniform float opacity;varying vec2 v;void main(){gl_FragColor=texture2D(tex,v)*opacity;}';
  function smooth(a, b, x) {
    var t = Math.max(0, Math.min(1, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  }
  function shader(gl, type, source) {
    var result = gl.createShader(type);
    gl.shaderSource(result, source);
    gl.compileShader(result);
    if (!gl.getShaderParameter(result, gl.COMPILE_STATUS)) {
      var message = gl.getShaderInfoLog(result);
      gl.deleteShader(result);
      throw new Error(message);
    }
    return result;
  }
  function loadImage(url) {
    return new Promise(function (resolve, reject) {
      var image = new Image();
      image.onload = function () { resolve(image); };
      image.onerror = function () { reject(new Error('Reference image missing: ' + url)); };
      image.src = url;
    });
  }
  async function create(base) {
    // Android loads this page through file://, where fetch(JSON) is unsupported.
    var model = window.REFERENCE_MODEL;
    if (!model) throw new Error('Reference model script missing');
    if (!model.sourceOnly || model.previousAssets.length) throw new Error('Non-reference assets rejected');
    var views = {};
    await Promise.all(Object.keys(model.views).map(async function (name) {
      views[name] = { image: await loadImage(new URL(model.views[name].file, base)),
                      info: model.views[name] };
    }));
    var patches = {}, composites = {}, expressionTextures = {};
    await Promise.all(Object.keys(model.expressions || {}).map(async function (pose) {
      patches[pose] = {};
      await Promise.all(Object.keys(model.expressions[pose]).map(async function (name) {
        patches[pose][name] = await loadImage(new URL(model.expressions[pose][name].file, base));
      }));
    }));
    function composeExpression(canvas, pose, name) {
      var ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(views[pose].image, 0, 0);
      if (patches[pose] && patches[pose][name]) {
        var rect = model.expressions[pose][name].rect;
        ctx.drawImage(patches[pose][name], rect[0], rect[1]);
      }
    }
    function expressionSource(pose, name, previous, mix) {
      if (!patches[pose]) return { image: views[pose].image, key: 'neutral' };
      name = patches[pose][name] ? name : 'neutral';
      previous = patches[pose][previous] ? previous : 'neutral';
      var step = Math.round(Math.max(0, Math.min(1, mix)) * 8);
      if (name === previous) step = 8;
      if (name === 'neutral' && (step === 8 || name === previous)) {
        return { image: views[pose].image, key: name };
      }
      var cached = composites[pose];
      if (!cached) {
        var copy = document.createElement('canvas');
        copy.width = views[pose].image.width; copy.height = views[pose].image.height;
        cached = composites[pose] = { canvas: copy, name: '' };
      }
      if (cached.name !== name) {
        composeExpression(cached.canvas, pose, name);
        cached.name = name;
      }
      if (step === 8 || name === previous) return { image: cached.canvas, key: name };
      var key = previous + ':' + name + ':' + step;
      if (!cached.transition) {
        cached.previous = cached.canvas.cloneNode();
        cached.transition = cached.canvas.cloneNode();
      }
      if (cached.previousName !== previous) {
        composeExpression(cached.previous, pose, previous);
        cached.previousName = previous;
      }
      if (cached.transitionKey !== key) {
        var ctx = cached.transition.getContext('2d');
        ctx.clearRect(0, 0, cached.transition.width, cached.transition.height);
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 1 - step / 8;
        ctx.drawImage(cached.previous, 0, 0);
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = step / 8;
        ctx.drawImage(cached.canvas, 0, 0);
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
        cached.transitionKey = key;
      }
      return { image: cached.transition, key: key };
    }
    var canvas = document.createElement('canvas');
    canvas.width = canvas.height = 768;
    canvas.style.cssText = 'width:100%;height:100%;display:block;';
    canvas.dataset.character = model.id;
    var surface = document.createElementNS('http://www.w3.org/2000/svg', 'foreignObject');
    surface.setAttribute('x', '0'); surface.setAttribute('y', '0');
    surface.setAttribute('width', '256'); surface.setAttribute('height', '256');
    var html = document.createElementNS('http://www.w3.org/1999/xhtml', 'div');
    html.style.cssText = 'width:256px;height:256px;background:transparent;';
    html.appendChild(canvas); surface.appendChild(html);
    var gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true,
      antialias: true, preserveDrawingBuffer: true });
    var fallback = gl ? null : canvas.getContext('2d', { alpha: true });
    if (!gl && !fallback) throw new Error('No character canvas context');
    var program, buffer, shaders = [], textures = {}, locations, lost = false, disposed = false, lastOptions = {};
    var vertices = new Float32Array(20 * 40 * 6 * 4);
    function init() {
      shaders = [shader(gl, gl.VERTEX_SHADER, VS), shader(gl, gl.FRAGMENT_SHADER, FS)];
      program = gl.createProgram();
      shaders.forEach(function (s) { gl.attachShader(program, s); });
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
      buffer = gl.createBuffer();
      locations = { p: gl.getAttribLocation(program, 'p'), uv: gl.getAttribLocation(program, 'uv'),
                    opacity: gl.getUniformLocation(program, 'opacity') };
      textures = {};
      expressionTextures = {};
      Object.keys(views).forEach(function (name) {
        var tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, views[name].image);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        textures[name] = tex;
      });
      gl.enable(gl.BLEND);
      // Weighted premultiplied views sum to one: do not dim the character halfway.
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.clearColor(0, 0, 0, 0);
    }
    if (gl) init();
    function contextLost(event) { if (!disposed) { event.preventDefault(); lost = true; } }
    function contextRestored() {
      if (disposed) return;
      try { init(); lost = false; draw(null, null, lastOptions); }
      catch (error) { window.dispatchEvent(new ErrorEvent('error', { message: String(error) })); }
    }
    canvas.addEventListener('webglcontextlost', contextLost);
    canvas.addEventListener('webglcontextrestored', contextRestored);
    function drawView(name, opacity, options) {
      if (opacity <= .001) return;
      var item = views[name], seated = name.indexOf('sit-') === 0;
      var scale = Number(item.info.scale) || .29;
      var w = item.image.width * scale, h = item.image.height * scale;
      var rest = Math.max(0, Math.min(1, Number(options.sit) || 0));
      var time = options.reducedMotion ? 0 : Number(options.t) || 0;
      var neck = item.info.rig.neck;
      var sleeping = name.indexOf('sleep-') === 0;
      var sleep = Math.max(0, Math.min(1, Number(options.sleep) || 0));
      function facePoint(pose) {
        var view = views[pose], point = view.info.rig.face || [.5, .3];
        var unit = Number(view.info.scale) || .29;
        return [128 + (point[0] - .5) * view.image.width * unit,
          252 - (1 - point[1]) * view.image.height * unit];
      }
      var ownFace = facePoint(name), standFace = facePoint('stand-front');
      var sitFace = facePoint('sit-front'), sleepFace = facePoint('sleep-front');
      var targetFace = standFace.map(function (value, i) {
        return (value * (1 - rest) + sitFace[i] * rest) * (1 - sleep) + sleepFace[i] * sleep;
      });
      var shiftX = targetFace[0] - ownFace[0], shiftY = targetFace[1] - ownFace[1];
      // Whole-pose registration is rigid. Aligning heads by stretching toward
      // fixed feet made the torso and legs collapse between reference poses.
      var settle = Math.sin(rest * Math.PI), lower = Math.sin(sleep * Math.PI);
      var poseTilt = options.reducedMotion ? 0 : sleeping ? -.025 * lower
        : seated ? .025 * settle - .035 * lower : -.025 * settle;
      var poseLift = options.reducedMotion ? 0 : sleeping ? -2 * lower
        : seated ? -2 * settle - 2 * lower : -1.5 * settle;
      var pivotY = ownFace[1];
      var expression = options.expression || 'neutral';
      var expressionMix = options.expressionMix == null ? 1 : Number(options.expressionMix);
      if (!isFinite(expressionMix) || options.reducedMotion) expressionMix = 1;
      var facialSource = expressionSource(name, expression, options.previousExpression || expression, expressionMix);
      var source = facialSource.image;
      var gesture = !options.reducedMotion ? options.gesture : null;
      var k = gesture ? Math.max(0, Math.min(1, Number(gesture.k) || 0)) : 0;
      var strength = gesture && gesture.strength != null ? Math.max(0, Math.min(1, gesture.strength)) : 1;
      var envelope = Math.pow(Math.sin(k * Math.PI), 2) * strength
        * (1 - smooth(0, .20, rest)) * (1 - smooth(0, .20, sleep));
      var yawn = Math.max(0, Math.min(1, Number(options.yawn) || 0));
      var yawnActive = yawn > .001 && yawn < .999;
      var yawnEnvelope = options.reducedMotion || !yawnActive ? 0
        : Math.pow(Math.sin(yawn * Math.PI), 2) * smooth(.85, 1, rest) * (1 - smooth(.02, .3, sleep));
      var kind = gesture ? gesture.kind : '';
      var tilt = kind === 'tilt' ? envelope * .07 : kind === 'wave' ? envelope * -.035 : 0;
      var nod = kind === 'nod' ? Math.sin(k * Math.PI * 4) * envelope * 2 : 0;
      if (fallback && options.reducedMotion) {
        fallback.save();
        fallback.globalAlpha = opacity;
        fallback.globalCompositeOperation = 'lighter';
        fallback.translate((128 + shiftX) * 3, (pivotY + poseLift + shiftY) * 3);
        fallback.rotate(poseTilt + tilt * .35);
        fallback.drawImage(source, -w * 1.5,
          (252 - h - pivotY + nod * .5 - (kind === 'stretch' ? envelope * 1.5 : 0)) * 3, w * 3, h * 3);
        fallback.restore();
        return;
      }
      var count = 0;
      function point(u, v) {
        var x = 128 + (u - .5) * w;
        var y = 252 - (1 - v) * h;
        var head = sleeping ? 0 : 1 - smooth(neck - .035, neck + .12, v);
        var edge = smooth(.16, .43, Math.abs(u - .5));
        var hair = edge * (1 - smooth(.66, .91, v));
        var still = (1 - rest * .94) * (options.reducedMotion || sleeping ? 0 : 1);
        var breath = Math.sin(time * 1.6) * .65 * still;
        var lean = Math.sin(time * .65) * .65 * still;
        var look = options.look && Number(options.look[1]) || 0;
        x += lean * (1 - v) + Math.sin(time * 1.2 + v * 3) * hair * .8 * still;
        y += breath * (1 - v) + head * look * .20;
        if (!options.reducedMotion) {
          if (sleeping) {
            // Prone chest rises while the face, hands and floor contact stay put.
            var chest = Math.exp(-Math.pow((u - .70) / .23, 2))
              * smooth(.52, .62, u)
              * smooth(.08, .26, v) * (1 - smooth(.70, .98, v));
            y -= (1 - Math.cos(time * Math.PI * 2 / 4.8)) * 1.15 * chest;
          } else {
            var gaze = Math.max(-1, Math.min(1, Number(options.gazeX) || 0));
            x += gaze * 7 * head;
            if (options.drowsy) {
              var tired = Math.max(0, Math.min(1, Number(options.drowsyAmount) || 0));
              var dip = Math.pow((1 - Math.cos(time * Math.PI * 2 / 4.6)) / 2, 2);
              var angle = (dip * .045 + .012) * tired * head;
              var neckY = 252 - (1 - neck) * h;
              var hx = x - ownFace[0], hy = y - neckY;
              x = ownFace[0] + hx * Math.cos(angle) - hy * Math.sin(angle);
              y = neckY + hx * Math.sin(angle) + hy * Math.cos(angle) + dip * tired * head * 2.2;
            }
          }
          if (yawnEnvelope > .001 && seated && !sleeping) {
            var leftArm = Math.exp(-Math.pow((u - .23) / .15, 2) - Math.pow((v - .59) / .20, 2));
            var rightArm = Math.exp(-Math.pow((u - .77) / .15, 2) - Math.pow((v - .59) / .20, 2));
            var armWeight = leftArm + rightArm;
            y -= armWeight * yawnEnvelope * 12;
            x += (rightArm - leftArm) * yawnEnvelope * 4;
            y -= yawnEnvelope * (1 - v) * 2;
          }
        }
        if (gesture && still) {
          // Profile drawings document the costume, not an animation pose.
          var gesturePivotY = 252 - (1 - neck) * h;
          var angle = tilt * head, dx = x - 128, dy = y - gesturePivotY;
          x = 128 + dx * Math.cos(angle) - dy * Math.sin(angle);
          y = gesturePivotY + dx * Math.sin(angle) + dy * Math.cos(angle) + nod * head;
          if (kind === 'earTwitch') {
            var ears = item.info.rig.ears;
            ears.forEach(function (ear, index) {
              var weight = Math.exp(-Math.pow((u - ear[0]) / .105, 2) - Math.pow((v - ear[1]) / .09, 2));
              x += weight * Math.sin(k * Math.PI * 6 + index * .8) * envelope * 1.8;
              y -= weight * envelope;
            });
          }
          if (kind === 'wave') {
            var arm = Math.exp(-Math.pow((u - .79) / .105, 2) - Math.pow((v - .59) / .12, 2));
            x += arm * envelope * (2 + Math.sin(k * Math.PI * 4) * 2);
            y -= arm * envelope * 5;
          }
          if (kind === 'stretch') {
            var leftArm = Math.exp(-Math.pow((u - .21) / .15, 2) - Math.pow((v - .59) / .19, 2));
            var rightArm = Math.exp(-Math.pow((u - .79) / .15, 2) - Math.pow((v - .59) / .19, 2));
            x += envelope * ((u - .5) * 1.5 * (1 - v) + (rightArm - leftArm) * 2.5);
            y -= envelope * (1.5 * (1 - v) + (leftArm + rightArm) * 5);
          }
        }
        var poseX = x - 128, poseY = y - pivotY;
        x = 128 + poseX * Math.cos(poseTilt) - poseY * Math.sin(poseTilt) + shiftX;
        y = pivotY + poseX * Math.sin(poseTilt) + poseY * Math.cos(poseTilt) + poseLift + shiftY;
        return [x, y];
      }
      if (fallback) {
        fallback.save();
        fallback.globalAlpha = opacity;
        fallback.globalCompositeOperation = 'lighter';
        // Share mesh motion with WebGL; a rigid fallback lost all sleep breathing.
        function triangle(a, b, c) {
          var pa = point(a[0], a[1]), pb = point(b[0], b[1]), pc = point(c[0], c[1]);
          var ax = a[0] * source.width, ay = a[1] * source.height;
          var bx = b[0] * source.width - ax, by = b[1] * source.height - ay;
          var cx = c[0] * source.width - ax, cy = c[1] * source.height - ay;
          var det = bx * cy - by * cx;
          var m0 = ((pb[0] - pa[0]) * cy - (pc[0] - pa[0]) * by) * 3 / det;
          var m1 = ((pb[1] - pa[1]) * cy - (pc[1] - pa[1]) * by) * 3 / det;
          var m2 = ((pc[0] - pa[0]) * bx - (pb[0] - pa[0]) * cx) * 3 / det;
          var m3 = ((pc[1] - pa[1]) * bx - (pb[1] - pa[1]) * cx) * 3 / det;
          fallback.save(); fallback.beginPath();
          fallback.moveTo(pa[0] * 3, pa[1] * 3); fallback.lineTo(pb[0] * 3, pb[1] * 3);
          fallback.lineTo(pc[0] * 3, pc[1] * 3); fallback.closePath(); fallback.clip();
          fallback.transform(m0, m1, m2, m3, pa[0] * 3 - m0 * ax - m2 * ay, pa[1] * 3 - m1 * ax - m3 * ay);
          fallback.drawImage(source, 0, 0); fallback.restore();
        }
        for (var r = 0; r < 16; r++) for (var c = 0; c < 8; c++) {
          var a = [c / 8, r / 16], b = [(c + 1) / 8, r / 16];
          var d = [c / 8, (r + 1) / 16], e = [(c + 1) / 8, (r + 1) / 16];
          triangle(a, b, d); triangle(d, b, e);
        }
        fallback.restore();
        return;
      }
      function vertex(u, v) {
        var p = point(u, v), x = p[0], y = p[1];
        vertices[count++] = x; vertices[count++] = y;
        vertices[count++] = u; vertices[count++] = v;
      }
      for (var row = 0; row < 40; row++) {
        for (var col = 0; col < 20; col++) {
          var a = col / 20, b = (col + 1) / 20, c = row / 40, d = (row + 1) / 40;
          vertex(a, c); vertex(b, c); vertex(a, d);
          vertex(a, d); vertex(b, c); vertex(b, d);
        }
      }
      var texture = textures[name];
      if (source !== item.image) {
        var dynamic = expressionTextures[name];
        if (!dynamic) {
          dynamic = expressionTextures[name] = { texture: gl.createTexture(), name: '' };
          gl.bindTexture(gl.TEXTURE_2D, dynamic.texture);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        }
        if (dynamic.name !== facialSource.key) {
          gl.bindTexture(gl.TEXTURE_2D, dynamic.texture);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
          dynamic.name = facialSource.key;
        }
        texture = dynamic.texture;
      }
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.uniform1f(locations.opacity, opacity);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.DYNAMIC_DRAW);
      gl.vertexAttribPointer(locations.p, 2, gl.FLOAT, false, 16, 0);
      gl.vertexAttribPointer(locations.uv, 2, gl.FLOAT, false, 16, 8);
      gl.enableVertexAttribArray(locations.p); gl.enableVertexAttribArray(locations.uv);
      gl.drawArrays(gl.TRIANGLES, 0, count / 4);
    }
    function draw(root, face, options) {
      if (disposed) return;
      lastOptions = options || {};
      if (root && surface.parentNode !== root) { root.textContent = ''; root.appendChild(surface); }
      if (lost) return;
      if (gl) {
        gl.viewport(0, 0, 768, 768); gl.clear(gl.COLOR_BUFFER_BIT); gl.useProgram(program);
      } else { fallback.clearRect(0, 0, 768, 768); }
      var rest = Math.max(0, Math.min(1, Number(lastOptions.sit) || 0));
      // The controller already applies quintic easing. Compressing it into a
      // narrow midpoint window made the actual pose switch happen in a flash.
      // Use the same progress for image weights and face registration throughout.
      var mix = rest;
      var sleep = Math.max(0, Math.min(1, Number(lastOptions.sleep) || 0));
      drawView('stand-front', (1 - mix) * (1 - sleep), lastOptions);
      drawView('sit-front', mix * (1 - sleep), lastOptions);
      if (views['sleep-front']) drawView('sleep-front', sleep, lastOptions);
    }
    function dispose() {
      if (disposed) return;
      disposed = true;
      canvas.removeEventListener('webglcontextlost', contextLost);
      canvas.removeEventListener('webglcontextrestored', contextRestored);
      if (gl && !lost) {
        Object.keys(textures).forEach(function (name) { gl.deleteTexture(textures[name]); });
        Object.keys(expressionTextures).forEach(function (name) { gl.deleteTexture(expressionTextures[name].texture); });
        gl.deleteBuffer(buffer); gl.deleteProgram(program);
        shaders.forEach(function (s) { gl.deleteShader(s); });
      }
      surface.remove();
      if (gl && !lost) {
        var extension = gl.getExtension('WEBGL_lose_context');
        if (extension) extension.loseContext();
      }
    }
    return { draw: draw, dispose: dispose, info: function () {
      return { id: model.id, sourceOnly: true, previousAssets: [], views: Object.keys(views),
               referencePoses: true,
               pose: Number(lastOptions.sleep) >= 1 ? 'sleep-front' : Number(lastOptions.sit) >= 1 ? 'sit-front' : 'stand-front',
               expressions: ['neutral'].concat(Object.keys(patches['stand-front'] || {})),
               expression: lastOptions.expression || 'neutral',
               expressionMix: lastOptions.expressionMix == null ? 1 : lastOptions.expressionMix,
               gazeX: Number(lastOptions.gazeX) || 0,
               drowsyAmount: Number(lastOptions.drowsyAmount) || 0,
               gesture: lastOptions.gesture ? lastOptions.gesture.kind : '',
               view: 'front',
               expressionTextureCount: Object.keys(expressionTextures).length,
               vertices: 861, triangles: 1600, renderer: gl ? 'webgl-mesh' : 'canvas-fallback' };
    } };
  }
  window.ReferenceCharacter = { create: create };
})();
