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
      // Reference profiles look left; the unmirrored overlay looks inward right.
      if (name.endsWith('-side')) {
        var item = views[name], copy = document.createElement('canvas');
        copy.width = item.image.width; copy.height = item.image.height;
        var ctx = copy.getContext('2d');
        ctx.translate(copy.width, 0); ctx.scale(-1, 1); ctx.drawImage(item.image, 0, 0);
        item.image = copy;
        var face = item.info.rig.face || [.5, .3];
        item.info = Object.assign({}, item.info, { rig: Object.assign({}, item.info.rig,
          { face: [1 - face[0], face[1]] }) });
      }
    }));
    var patches = {}, composites = {}, expressionTextures = {};
    await Promise.all(Object.keys(model.expressions || {}).map(async function (pose) {
      patches[pose] = {};
      await Promise.all(Object.keys(model.expressions[pose]).map(async function (name) {
        patches[pose][name] = await loadImage(new URL(model.expressions[pose][name].file, base));
      }));
    }));
    function expressionSource(pose, name) {
      if (!patches[pose] || !patches[pose][name]) return views[pose].image;
      var cached = composites[pose];
      if (!cached) {
        var copy = document.createElement('canvas');
        copy.width = views[pose].image.width; copy.height = views[pose].image.height;
        cached = composites[pose] = { canvas: copy, name: '' };
      }
      if (cached.name !== name) {
        var ctx = cached.canvas.getContext('2d');
        ctx.clearRect(0, 0, cached.canvas.width, cached.canvas.height);
        ctx.drawImage(views[pose].image, 0, 0);
        var rect = model.expressions[pose][name].rect;
        ctx.drawImage(patches[pose][name], rect[0], rect[1]);
        cached.name = name;
      }
      return cached.canvas;
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
    canvas.addEventListener('webglcontextlost', function (event) { event.preventDefault(); lost = true; });
    canvas.addEventListener('webglcontextrestored', function () {
      if (disposed) return;
      try { init(); lost = false; draw(null, null, lastOptions); }
      catch (error) { window.dispatchEvent(new ErrorEvent('error', { message: String(error) })); }
    });
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
      var faceV = (item.info.rig.face || [.5, .3])[1];
      var expression = options.expression || 'neutral';
      var source = expressionSource(name, expression);
      var gesture = !options.reducedMotion && rest < .02 && sleep < .02 ? options.gesture : null;
      var k = gesture ? Math.max(0, Math.min(1, Number(gesture.k) || 0)) : 0;
      var envelope = Math.pow(Math.sin(k * Math.PI), 2);
      var kind = gesture ? gesture.kind : '';
      var tilt = kind === 'tilt' ? envelope * .15 : kind === 'wave' ? envelope * -.07 : 0;
      var nod = kind === 'nod' ? Math.sin(k * Math.PI * 4) * envelope * 5 : 0;
      if (fallback) {
        fallback.save();
        fallback.globalAlpha = opacity;
        fallback.globalCompositeOperation = 'lighter';
        fallback.translate(384, 756);
        fallback.rotate(tilt * .35);
        var yScale = (252 - targetFace[1]) / (252 - ownFace[1]);
        if (kind === 'stretch') {
          fallback.scale(1 + envelope * .025, 1 + envelope * .035);
        }
        fallback.drawImage(source, (-w * .5 + shiftX) * 3,
          (-h * yScale + nod * .5) * 3, w * 3, h * yScale * 3);
        fallback.restore();
        return;
      }
      var count = 0;
      function vertex(u, v) {
        var x = 128 + (u - .5) * w;
        var y = 252 - (1 - v) * h;
        var head = sleeping ? 0 : 1 - smooth(neck - .035, neck + .12, v);
        var edge = smooth(.16, .43, Math.abs(u - .5));
        var hair = edge * (1 - smooth(.66, .91, v));
        var still = (1 - rest * .94) * (options.reducedMotion ? 0 : 1);
        var breath = Math.sin(time * 1.6) * .65 * still;
        var lean = Math.sin(time * .65) * .65 * still;
        var look = options.look && Number(options.look[1]) || 0;
        x += lean * (1 - v) + Math.sin(time * 1.2 + v * 3) * hair * .8 * still;
        // Head registration is rigid above the face, then tapers to fixed feet.
        var poseWeight = Math.min(1, (1 - v) / Math.max(.1, 1 - faceV));
        x += shiftX * poseWeight;
        y += shiftY * poseWeight;
        y += breath * (1 - v) + head * look * .20;
        if (!sleeping && !options.reducedMotion) {
          if (options.drowsy) y += (1 - Math.cos(time * 2)) * 2 * head;
        }
        if (gesture && still) {
          var pivotY = 252 - (1 - neck) * h;
          var angle = tilt * head, dx = x - 128, dy = y - pivotY;
          x = 128 + dx * Math.cos(angle) - dy * Math.sin(angle);
          y = pivotY + dx * Math.sin(angle) + dy * Math.cos(angle) + nod * head;
          if (kind === 'earTwitch') {
            var ears = item.info.rig.ears;
            ears.forEach(function (ear, index) {
              var weight = Math.exp(-Math.pow((u - ear[0]) / .105, 2) - Math.pow((v - ear[1]) / .09, 2));
              x += weight * Math.sin(k * Math.PI * 6 + index * .8) * envelope * 4;
              y -= weight * envelope * 2;
            });
          }
          if (kind === 'wave') {
            var arm = Math.exp(-Math.pow((u - .79) / .105, 2) - Math.pow((v - .59) / .12, 2));
            x += arm * envelope * (4 + Math.sin(k * Math.PI * 6) * 4);
            y -= arm * envelope * 12;
          }
          if (kind === 'stretch') {
            var leftArm = Math.exp(-Math.pow((u - .21) / .15, 2) - Math.pow((v - .59) / .19, 2));
            var rightArm = Math.exp(-Math.pow((u - .79) / .15, 2) - Math.pow((v - .59) / .19, 2));
            x += envelope * ((u - .5) * 5 * (1 - v) + (rightArm - leftArm) * 7);
            y -= envelope * (4 * (1 - v) + (leftArm + rightArm) * 15);
          }
        }
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
        if (dynamic.name !== expression) {
          gl.bindTexture(gl.TEXTURE_2D, dynamic.texture);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
          dynamic.name = expression;
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
      var mix = smooth(.43, .57, rest);
      var sleep = smooth(.40, .60, Math.max(0, Math.min(1, Number(lastOptions.sleep) || 0)));
      var gesture = !lastOptions.reducedMotion && rest < .02 && sleep < .02 ? lastOptions.gesture : null;
      var k = gesture ? Math.max(0, Math.min(1, Number(gesture.k) || 0)) : 0;
      var profile = lastOptions.view === 'side' ? 1 : gesture && gesture.kind === 'sideLook'
        ? smooth(.05, .22, k) * (1 - smooth(.78, .95, k)) : 0;
      drawView('stand-front', (1 - profile) * (1 - mix) * (1 - sleep), lastOptions);
      drawView('stand-side', profile * (1 - mix) * (1 - sleep), lastOptions);
      drawView('sit-front', (1 - profile) * mix * (1 - sleep), lastOptions);
      drawView('sit-side', profile * mix * (1 - sleep), lastOptions);
      if (views['sleep-front']) drawView('sleep-front', sleep, lastOptions);
    }
    function dispose() {
      if (disposed) return;
      disposed = true;
      if (gl && !lost) {
        Object.keys(textures).forEach(function (name) { gl.deleteTexture(textures[name]); });
        Object.keys(expressionTextures).forEach(function (name) { gl.deleteTexture(expressionTextures[name].texture); });
        gl.deleteBuffer(buffer); gl.deleteProgram(program);
        shaders.forEach(function (s) { gl.deleteShader(s); });
      }
      surface.remove();
    }
    return { draw: draw, dispose: dispose, info: function () {
      return { id: model.id, sourceOnly: true, previousAssets: [], views: Object.keys(views),
               expressions: ['neutral'].concat(Object.keys(patches['stand-front'] || {})),
               expression: lastOptions.expression || 'neutral',
               gesture: lastOptions.gesture ? lastOptions.gesture.kind : '',
               view: lastOptions.view === 'side' || lastOptions.gesture && lastOptions.gesture.kind === 'sideLook'
                 && lastOptions.gesture.k > .22 && lastOptions.gesture.k < .78 ? 'side' : 'front',
               expressionTextureCount: Object.keys(expressionTextures).length,
               vertices: 861, triangles: 1600, renderer: gl ? 'webgl-mesh' : 'canvas-fallback' };
    } };
  }
  window.ReferenceCharacter = { create: create };
})();
