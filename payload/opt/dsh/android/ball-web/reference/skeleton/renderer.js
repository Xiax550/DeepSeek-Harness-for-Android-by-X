/* Current-reference artwork, articulated by a single Three.js bone hierarchy. */
(function () {
  'use strict';
  var THREE = window.THREE;
  var RAD = Math.PI / 180;
  function clamp(x) { return Math.max(0, Math.min(1, Number(x) || 0)); }
  function smooth(a, b, x) { var k = clamp((x - a) / (b - a)); return k * k * (3 - 2 * k); }
  function lerp(a, b, k) { return a + (b - a) * k; }
  function image(url) {
    return new Promise(function (resolve, reject) {
      var img = new Image(); img.onload = function () { resolve(img); };
      img.onerror = function () { reject(new Error('Missing skeletal layer: ' + url)); };
      img.src = url;
    });
  }

  async function create(base) {
    var model = window.DHA_SKELETON;
    if (!THREE || !model || !model.sourceOnly || model.previousAssets.length) throw new Error('Reference skeleton unavailable');
    var assets = new URL('./skeleton/', base);
    var scale = model.scale;
    function point(p) { return [128 + (p[0] - model.sourceSize[0] / 2) * scale,
      252 - (model.sourceSize[1] - p[1]) * scale]; }
    var canvas = document.createElement('canvas');
    canvas.width = canvas.height = 768;
    canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block';
    var referenceCanvas = document.createElement('canvas');
    referenceCanvas.width = referenceCanvas.height = 768;
    referenceCanvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none';
    var referenceContext = referenceCanvas.getContext('2d');
    canvas.dataset.character = model.id;
    var surface = document.createElementNS('http://www.w3.org/2000/svg', 'foreignObject');
    surface.setAttribute('width', '256'); surface.setAttribute('height', '256');
    var container = document.createElementNS('http://www.w3.org/1999/xhtml', 'div');
    container.style.cssText = 'position:relative;width:256px;height:256px;background:transparent;overflow:visible';
    container.appendChild(canvas); container.appendChild(referenceCanvas); surface.appendChild(container);
    var context = canvas.getContext('webgl2', { alpha: true, antialias: true, preserveDrawingBuffer: true })
      || canvas.getContext('webgl', { alpha: true, antialias: true, preserveDrawingBuffer: true });
    var renderer = context ? new THREE.WebGLRenderer({ canvas: canvas, context: context,
      alpha: true, antialias: true, preserveDrawingBuffer: true }) : null;
    var fallback = renderer ? null : canvas.getContext('2d');
    if (!renderer && !fallback) throw new Error('No skeletal drawing context');
    if (renderer) {
      renderer.setSize(768, 768, false); renderer.setClearColor(0, 0);
      renderer.outputColorSpace = THREE.SRGBColorSpace;
    }
    var scene = new THREE.Scene();
    var stage = new THREE.Group(); scene.add(stage);
    // Fixed transparent overscan preserves thin antialiased strand tips. It is
    // identical for every pose, so transitions cannot pump the character size.
    var pixelScale = 768 / 260, overscan = 2;
    var camera = new THREE.OrthographicCamera(-2, 258, -2, 258, .1, 1000);
    camera.position.z = 500;
    var bones = [], byName = {}, bind = {}, bindPoints = {};
    model.bones.forEach(function (spec) {
      var bone = new THREE.Bone(); bone.name = spec.name;
      var p = point(spec.point), parentPoint = spec.parent ? bindPoints[spec.parent] : [0, 0];
      bone.position.set(p[0] - parentPoint[0], p[1] - parentPoint[1], 0);
      bind[spec.name] = bone.position.clone(); bindPoints[spec.name] = p;
      bones.push(bone); byName[spec.name] = bone;
      if (spec.parent) byName[spec.parent].add(bone); else stage.add(bone);
    });
    scene.updateMatrixWorld(true);
    var skeleton = new THREE.Skeleton(bones);
    skeleton.calculateInverses();
    var parts = [], textures = [], facialPatches = {}, referenceImages = {}, referencePatches = {},
      referenceFrames = {}, disposed = false, lost = false, lastOptions = {}, referenceBlend = {};
    var motionPlayer = null, rigDirty = false;
    var motionJoin = null, motionEntry = null, joinCanvas = null, JOIN_MS = 260, hasDrawn = false;
    var faceCanvas, faceContext, faceMask, faceTexture, faceKey = '';
    var expressionFrames = {};
    function releaseRenderer() {
      if (!renderer) return;
      renderer.dispose(); renderer.forceContextLoss();
    }
    // Complete asset loading before allocating textures so a missing layer cannot
    // leak a partially built GPU rig while other image promises are still pending.
    var loadedImages;
    try {
      var drawableParts = model.parts;
      loadedImages = await Promise.all(drawableParts.map(function (part) { return image(new URL(part.file, assets)); }));
      var expressionInfo = window.REFERENCE_MODEL.expressions['stand-front'];
      var requests = Object.keys(expressionInfo).map(async function (name) {
        facialPatches[name] = await image(new URL(expressionInfo[name].file, base));
      });
      ['sit-front', 'sleep-front'].forEach(function (poseName) {
        var poseInfo = window.REFERENCE_MODEL.views[poseName];
        requests.push(image(new URL(poseInfo.file, base)).then(function (img) { referenceImages[poseName] = img; }));
        referencePatches[poseName] = {};
        Object.keys(window.REFERENCE_MODEL.expressions[poseName] || {}).forEach(function (name) {
          var info = window.REFERENCE_MODEL.expressions[poseName][name];
          requests.push(image(new URL(info.file, base)).then(function (img) {
            referencePatches[poseName][name] = { image: img, rect: info.rect };
          }));
        });
      });
      await Promise.all(requests);
      if (window.WholeBodyMotion) motionPlayer = await window.WholeBodyMotion.create(base);
    } catch (error) {
      skeleton.dispose(); releaseRenderer();
      throw error;
    }
    drawableParts.forEach(function (part, partIndex) {
      var img = loadedImages[partIndex];
      var texture = new THREE.Texture(img); texture.colorSpace = THREE.SRGBColorSpace;
      texture.minFilter = THREE.LinearFilter; texture.magFilter = THREE.LinearFilter;
      texture.generateMipmaps = false; texture.needsUpdate = true; textures.push(texture);
      var rect = part.rect, a = point([rect[0], rect[1]]), b = point([rect[2], rect[3]]);
      var hair = part.name === 'hairL' || part.name === 'hairR';
      var tail = part.name === 'tail';
      var limb = /^(arm|forearm|hand|thigh|shin|foot)[LR]$/.test(part.name);
      var tailPart = tail || part.name === 'tailTip';
      var columns = tailPart ? 4 : 2, rows = hair ? 24 : limb || tailPart ? 8 : 2;
      var position = [], uv = [], skinIndex = [], skinWeight = [], indices = [];
      var boneIndex = bones.indexOf(byName[part.bone]);
      var hairBones = hair ? ['hair', 'hairMid', 'hairTip', 'hairEnd'].map(function (prefix) {
        return bones.indexOf(byName[prefix + (part.name === 'hairL' ? 'L' : 'R')]);
      }) : [boneIndex];
      for (var row = 0; row <= rows; row++) {
        for (var col = 0; col <= columns; col++) {
          var u = col / columns, v = row / rows;
          position.push(lerp(a[0], b[0], u), lerp(a[1], b[1], v), 0);
          uv.push(u, 1 - v);
          var sourceY = lerp(rect[1], rect[3], v), segment = 0, mix = 0;
          if (hair) {
            segment = sourceY > 369 ? 2 : sourceY > 290 ? 1 : 0;
            var joint = [250, 330, 408][segment];
            mix = clamp((sourceY - joint + 40) / 80);
          }
          if (limb) {
            var side = part.name.slice(-1), leg = /^(thigh|shin|foot)/.test(part.name);
            var chain = leg ? ['thigh', 'shin', 'foot'] : ['arm', 'forearm', 'hand'];
            var first = smooth(leg ? 396 : 241, leg ? 432 : 281, sourceY);
            var second = smooth(leg ? 473 : 283, leg ? 505 : 315, sourceY);
            skinIndex.push(bones.indexOf(byName[chain[0] + side]),
              bones.indexOf(byName[chain[1] + side]), bones.indexOf(byName[chain[2] + side]), 0);
            skinWeight.push(1 - first, first * (1 - second), first * second, 0);
          } else if (tailPart) {
            var sourceX = lerp(rect[0], rect[2], u);
            var along = ((sourceX - 324) * 49 + (sourceY - 407) * 41) / Math.hypot(49, 41);
            var tip = smooth(-20, 20, along);
            skinIndex.push(bones.indexOf(byName.tail), bones.indexOf(byName.tailTip), 0, 0);
            skinWeight.push(1 - tip, tip, 0, 0);
          } else {
            skinIndex.push(hairBones[segment], hair ? hairBones[segment + 1] : boneIndex, 0, 0);
            skinWeight.push(1 - mix, mix, 0, 0);
          }
          if (row < rows && col < columns) {
            var i = row * (columns + 1) + col;
            indices.push(i, i + columns + 1, i + 1, i + 1, i + columns + 1, i + columns + 2);
          }
        }
      }
      if (part.name === 'skin') {
        position = []; uv = []; skinIndex = []; skinWeight = []; indices = model.mesh.indices;
        model.mesh.vertices.forEach(function (vertex) {
          var p = point(vertex);
          position.push(p[0], p[1], 0); uv.push(vertex[0] / model.sourceSize[0], 1 - vertex[1] / model.sourceSize[1]);
          skinIndex.push.apply(skinIndex, vertex.slice(2, 6));
          var weights = vertex.slice(6, 10), total = weights.reduce(function (a, b) { return a + b; }, 0);
          skinWeight.push.apply(skinWeight, weights.map(function (weight) { return weight / total; }));
        });
      }
      var geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
      geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndex, 4));
      geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeight, 4));
      geometry.setIndex(indices);
      var material = new THREE.MeshBasicMaterial({ map: texture, transparent: true, alphaTest: .01,
        depthTest: false, depthWrite: false, side: THREE.DoubleSide });
      var mesh = new THREE.SkinnedMesh(geometry, material); mesh.frustumCulled = false;
      mesh.bind(skeleton, new THREE.Matrix4()); mesh.renderOrder = part.z;
      stage.add(mesh);
      parts.push({ spec: part, image: img, texture: texture, mesh: mesh, boneIndex: boneIndex,
        articulatedSurface: hair || limb || tailPart || part.name === 'skin',
        rect: [a[0], a[1], b[0] - a[0], b[1] - a[1]] });
      if (part.name === 'head' || part.name === 'skin') {
        faceMask = img; faceTexture = texture;
        faceCanvas = document.createElement('canvas'); faceCanvas.width = img.width; faceCanvas.height = img.height;
        faceContext = faceCanvas.getContext('2d');
      }
    });
    parts.sort(function (a, b) { return a.spec.z - b.spec.z; });
    var headPart = parts.filter(function (p) { return p.spec.name === 'head' || p.spec.name === 'skin'; })[0];
    function expressionFrame(name) {
      if (expressionFrames[name]) return expressionFrames[name];
      var frame = document.createElement('canvas'); frame.width = faceMask.width; frame.height = faceMask.height;
      var ctx = frame.getContext('2d'); ctx.drawImage(faceMask, 0, 0);
      if (facialPatches[name]) {
        var rect = expressionInfo[name].rect, r = headPart.spec.rect;
        ctx.drawImage(facialPatches[name], rect[0] - r[0], rect[1] - r[1]);
      }
      ctx.globalCompositeOperation = 'destination-in'; ctx.drawImage(faceMask, 0, 0);
      expressionFrames[name] = frame;
      return frame;
    }
    function referenceFrame(poseName, expressionName, previousName, mix) {
      var poseExpressions = window.REFERENCE_MODEL.expressions[poseName] || {};
      var current = poseExpressions[expressionName] ? expressionName : '';
      var previous = poseExpressions[previousName] ? previousName : '';
      var step = current === previous ? 12 : Math.round(clamp(mix) * 12);
      var key = poseName + ':' + previous + ':' + current + ':' + step;
      if (referenceFrames[key]) return referenceFrames[key];
      var source = referenceImages[poseName];
      var frame = document.createElement('canvas'); frame.width = source.width; frame.height = source.height;
      var ctx = frame.getContext('2d'); ctx.drawImage(source, 0, 0);
      function patch(name, alpha) {
        var item = referencePatches[poseName][name];
        if (!item || alpha <= 0) return;
        ctx.globalAlpha = alpha; ctx.drawImage(item.image, item.rect[0], item.rect[1]);
      }
      patch(previous, 1 - step / 12); patch(current, step / 12); ctx.globalAlpha = 1;
      referenceFrames[key] = frame;
      return frame;
    }
    function drawReferenceGaze(frame, poseName, gaze, x, y, width, height, offset, breath) {
      var columns = 8, rows = 12, vertices = [];
      var face = window.REFERENCE_MODEL.views[poseName].rig.face;
      for (var row = 0; row <= rows; row++) {
        for (var col = 0; col <= columns; col++) {
          var u = col / columns, v = row / rows;
          var head = poseName === 'sleep-front'
            ? (1 - smooth(.43, .6, u)) * smooth(.22, .48, v)
            : 1 - smooth(.48, .74, v);
          var shift = head * (gaze * 2 * pixelScale
            - (u - face[0]) * width * .025 * Math.abs(gaze));
          var anchor = 1 - smooth(Math.min(.85, face[1] + .07), 1, v);
          var chest = poseName === 'sleep-front'
            ? smooth(.43, .58, u) * (1 - smooth(.8, 1, u))
              * (1 - smooth(.86, .96, v)) * Math.pow(Math.sin(v * Math.PI), 2) : 0;
          vertices.push({ x: x + u * width + shift + offset[0] * anchor,
            y: y + v * height + offset[1] * anchor - breath * chest * pixelScale,
            u: u * frame.width, v: v * frame.height });
        }
      }
      function triangle(p, q, r) {
        var du = q.u - p.u, dv = q.v - p.v, eu = r.u - p.u, ev = r.v - p.v;
        var det = du * ev - eu * dv;
        var a = ((q.x - p.x) * ev - (r.x - p.x) * dv) / det;
        var b = ((q.y - p.y) * ev - (r.y - p.y) * dv) / det;
        var c = (du * (r.x - p.x) - eu * (q.x - p.x)) / det;
        var d = (du * (r.y - p.y) - eu * (q.y - p.y)) / det;
        referenceContext.save(); referenceContext.beginPath();
        referenceContext.moveTo(p.x, p.y); referenceContext.lineTo(q.x, q.y);
        referenceContext.lineTo(r.x, r.y); referenceContext.closePath(); referenceContext.clip();
        referenceContext.transform(a, b, c, d, p.x - a * p.u - c * p.v, p.y - b * p.u - d * p.v);
        referenceContext.drawImage(frame, 0, 0); referenceContext.restore();
      }
      for (var j = 0; j < rows; j++) for (var i = 0; i < columns; i++) {
        var index = j * (columns + 1) + i;
        triangle(vertices[index], vertices[index + 1], vertices[index + columns + 1]);
        triangle(vertices[index + 1], vertices[index + columns + 2], vertices[index + columns + 1]);
      }
    }
    function drawReferencePose(poseName, alpha, options, targetFace) {
      if (alpha <= .001 || !referenceImages[poseName]) return;
      var view = window.REFERENCE_MODEL.views[poseName], img = referenceImages[poseName];
      var scale = Number(view.scale) || .29, width = img.width * scale, height = img.height * scale;
      var face = view.rig.face || [.5, .3];
      var ownFace = [128 + (face[0] - .5) * width, 252 - (1 - face[1]) * height];
      var left = 128 - width / 2;
      var top = 252 - height;
      var frame = referenceFrame(poseName, options.expression || 'neutral',
        options.previousExpression || options.expression || 'neutral', options.expressionMix == null ? 1 : options.expressionMix);
      var breath = poseName === 'sleep-front' && !options.reducedMotion
        ? Math.sin((Number(options.t) || 0) * Math.PI * 2 / 4.8) * .28 : 0;
      var destWidth = width * pixelScale, destHeight = height * pixelScale;
      var destX = (left + overscan) * pixelScale, destY = (top + overscan) * pixelScale;
      referenceContext.globalAlpha = alpha;
      var gaze = options.reducedMotion ? 0 : Math.max(-1, Math.min(1, Number(options.gazeX) || 0));
      var offset = [(targetFace[0] - ownFace[0]) * pixelScale, (targetFace[1] - ownFace[1]) * pixelScale];
      if (Math.abs(gaze) + Math.abs(offset[0]) + Math.abs(offset[1]) + Math.abs(breath) > .001)
        drawReferenceGaze(frame, poseName, gaze, destX, destY, destWidth, destHeight, offset, breath);
      else referenceContext.drawImage(frame, destX, destY, destWidth, destHeight);
      referenceContext.globalAlpha = 1;
    }
    function expression(options) {
      var current = facialPatches[options.expression] ? options.expression : 'neutral';
      var previous = facialPatches[options.previousExpression] ? options.previousExpression : 'neutral';
      var mix = options.expressionMix == null || options.reducedMotion ? 1 : clamp(options.expressionMix);
      if (previous === current) mix = 1;
      var step = Math.round(mix * 12), key = previous + ':' + current + ':' + step;
      if (key === faceKey) return;
      faceKey = key;
      faceContext.clearRect(0, 0, faceCanvas.width, faceCanvas.height);
      // Blend complete premultiplied frames, rather than layering two translucent
      // patches over a third (neutral) face. Additive weights preserve edge alpha.
      faceContext.globalCompositeOperation = 'source-over';
      faceContext.globalAlpha = 1 - step / 12;
      faceContext.drawImage(expressionFrame(previous), 0, 0);
      faceContext.globalCompositeOperation = 'lighter';
      faceContext.globalAlpha = step / 12;
      faceContext.drawImage(expressionFrame(current), 0, 0);
      faceContext.globalAlpha = 1;
      faceContext.globalCompositeOperation = 'source-over';
      faceTexture.image = faceCanvas; faceTexture.needsUpdate = true;
      headPart.image = faceCanvas;
    }
    function rotation(name, z, x, y) { byName[name].rotation.set((x || 0) * RAD, (y || 0) * RAD, z * RAD); }
    var worldQuaternion = new THREE.Quaternion(), worldAxis = new THREE.Vector3(1, 0, 0);
    function worldAngle(object) {
      object.getWorldQuaternion(worldQuaternion);
      return Math.atan2(worldAxis.clone().applyQuaternion(worldQuaternion).y,
        worldAxis.clone().applyQuaternion(worldQuaternion).x);
    }
    function aimChain(upperName, lowerName, endName, target, side, depthPole) {
      var upper = byName[upperName], lower = byName[lowerName], end = byName[endName];
      scene.updateMatrixWorld(true);
      var shoulder = upper.getWorldPosition(new THREE.Vector3());
      var parentAngle = worldAngle(upper.parent);
      var a = lower.position.length(), b = end.position.length();
      var dx = target[0] - shoulder.x, dy = target[1] - shoulder.y;
      var distance = Math.max(Math.abs(a - b) + 1e-8, Math.min(a + b, Math.hypot(dx, dy)));
      var theta = Math.atan2(dy, dx);
      var elbowAngle = Math.acos(Math.max(-1, Math.min(1,
        (a * a + distance * distance - b * b) / (2 * a * distance))));
      var upperBindAngle = Math.atan2(lower.position.y, lower.position.x);
      if (depthPole) {
        var axis = new THREE.Vector3(dx, dy, (target[2] || 0) - shoulder.z);
        var reach = axis.length();
        if (reach < .0001) axis.set(0, 1, 0); else axis.divideScalar(reach);
        distance = Math.max(Math.abs(a - b) + 1e-8, Math.min(a + b, reach));
        elbowAngle = Math.acos(Math.max(-1, Math.min(1,
          (a * a + distance * distance - b * b) / (2 * a * distance))));
        // Solve in world space including depth, also when the torso leans.
        var pole = new THREE.Vector3(0, -1, .75);
        pole.addScaledVector(axis, -pole.dot(axis)).normalize();
        var elbowTarget = shoulder.clone().addScaledVector(axis, a * Math.cos(elbowAngle))
          .addScaledVector(pole, a * Math.sin(elbowAngle));
        var inverseParent = upper.parent.getWorldQuaternion(new THREE.Quaternion()).invert();
        var upperDirection = elbowTarget.clone().sub(shoulder).normalize().applyQuaternion(inverseParent);
        upper.quaternion.setFromUnitVectors(lower.position.clone().normalize(), upperDirection);
        scene.updateMatrixWorld(true);
        var endpoint = shoulder.clone().addScaledVector(axis, distance);
        var inverseUpper = upper.getWorldQuaternion(new THREE.Quaternion()).invert();
        var lowerDirection = endpoint.sub(elbowTarget).normalize().applyQuaternion(inverseUpper);
        lower.quaternion.setFromUnitVectors(end.position.clone().normalize(), lowerDirection);
        scene.updateMatrixWorld(true);
        return;
      }
      // Keep the bend branch fixed throughout the clip. Re-ranking candidates
      // near a straight knee caused the elbow/knee to jump to the other side.
      var direction = theta + (side === 'left' ? 1 : -1) * elbowAngle;
      upper.rotation.z = direction - parentAngle - upperBindAngle;
      scene.updateMatrixWorld(true);
      var elbow = lower.getWorldPosition(new THREE.Vector3());
      var lowerBindAngle = Math.atan2(end.position.y, end.position.x);
      var targetAngle = Math.atan2(shoulder.y + Math.sin(theta) * distance - elbow.y,
        shoulder.x + Math.cos(theta) * distance - elbow.x);
      lower.rotation.z = targetAngle - parentAngle - upper.rotation.z - lowerBindAngle;
      scene.updateMatrixWorld(true);
    }
    function viewPoint(name, x, y) {
      var view = window.REFERENCE_MODEL.views[name];
      var size = view.size, scale = Number(view.scale) || .29;
      return [128 + (x - size[0] / 2) * scale, 252 - (size[1] - y) * scale];
    }
    var stageScale = 1, stageFit = {};
    function fitStageToCanvas() {
      stage.position.set(0, 0, 0); stage.scale.set(1, 1, 1);
      scene.updateMatrixWorld(true); skeleton.update();
      var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      var seen = new Uint8Array(model.mesh.vertices.length);
      parts.forEach(function (part) {
        var geometry = part.mesh.geometry, positions = geometry.attributes.position;
        var indices = geometry.index.array;
        seen.fill(0);
        for (var i = 0; i < indices.length; i++) {
          var index = indices[i];
          if (seen[index]) continue;
          seen[index] = 1;
          skinPoint.fromBufferAttribute(positions, index); part.mesh.applyBoneTransform(index, skinPoint);
          minX = Math.min(minX, skinPoint.x); maxX = Math.max(maxX, skinPoint.x);
          minY = Math.min(minY, skinPoint.y); maxY = Math.max(maxY, skinPoint.y);
        }
      });
      var footY = (byName.footL.getWorldPosition(new THREE.Vector3()).y
        + byName.footR.getWorldPosition(new THREE.Vector3()).y) / 2;
      var pad = 1;
      var fitX = (256 - pad * 2) / (maxX - minX + pad * 2);
      var fitTop = (footY - pad) / (footY - minY + pad);
      var fitBottom = (256 - pad - footY) / (maxY - footY + pad);
      // Keep one stable character size throughout the animation. The bounds
      // include transparent sprite corners, so using them to fit each frame
      // made the doll visibly shrink and grow while lowering to the floor.
      stageScale = 1;
      stageFit = { minX: minX, minY: minY, maxX: maxX, maxY: maxY,
        fitX: fitX, fitTop: fitTop, fitBottom: fitBottom };
      stage.scale.setScalar(1);
      stage.position.set(0, 0, 0);
      scene.updateMatrixWorld(true); skeleton.update();
    }
    function pose(options) {
      var s = clamp(options.sit), h = clamp(options.sleep), t = options.reducedMotion ? 0 : Number(options.t) || 0;
      // A yawn is a seated-only action. Its raised hands and chest stretch are
      // driven by one envelope that is zero at both ends, so entering and
      // leaving the action returns byte-for-byte to the approved seated pose.
      var yawn = clamp(options.yawn), yawnActive = yawn > .001 && yawn < .999;
      var yawnEnvelope = options.reducedMotion || !yawnActive ? 0
        : Math.pow(Math.sin(yawn * Math.PI), 2) * smooth(.85, 1, s) * (1 - smooth(.02, .3, h));
      stage.position.set(0, 0, 0); stage.scale.set(1, 1, 1); stageScale = 1;
      bones.forEach(function (bone) { bone.position.copy(bind[bone.name]); bone.rotation.set(0, 0, 0); bone.scale.set(1, 1, 1); });
      var root = byName.hips;
      // Plant the hands before transferring weight onto the forearms. The hip
      // rolls only after support is established; the head is lowered last.
      var support = smooth(.02, .32, h);
      var settle = smooth(.28, .92, h), pelvisRoll = -85 * settle;
      var spineRoll = -20 * smooth(.3, .9, h);
      root.position.x = lerp(bind.hips.x, 178, settle);
      root.position.y = lerp(bind.hips.y + 62 * s, 208, settle);
      rotation('hips', pelvisRoll);
      var breathing = options.reducedMotion ? 0 : Math.sin(t * 1.6) * .42 * (h || s * .12);
      var lean = Math.sin(s * Math.PI) * 2.5 * (1 - h);
      var spineSit = smooth(.2, .85, s) * (1 - h);
      var spinePoseAngle = lerp(0, -8, spineSit) + spineRoll;
      rotation('spine', lean + breathing);
      byName.spine.rotation.z += spinePoseAngle * RAD;
      byName.spine.rotation.x = 70 * smooth(.2, .85, s) * (1 - smooth(.5, 1, h)) * RAD;
      scene.updateMatrixWorld(true);
      byName.skirt.quaternion.copy(byName.skirt.parent.getWorldQuaternion(new THREE.Quaternion()).invert())
        .multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(
          (60 * s + 20 * h) * RAD, 0, 0)));
      var bodyAngle = pelvisRoll + lean + breathing + spinePoseAngle;
      rotation('head', -bodyAngle - 15 * smooth(.55, 1, h));
      scene.updateMatrixWorld(true);
      byName.head.quaternion.copy(byName.head.parent.getWorldQuaternion(new THREE.Quaternion()).invert())
        .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -15 * smooth(.55, 1, h) * RAD));
      if (options.drowsy && !options.reducedMotion) byName.head.rotation.z +=
        (2 + 3 * Math.sin(t * 1.25)) * (1 - h) * clamp(options.drowsyAmount) * RAD;
      if (yawnEnvelope > .001) {
        byName.spine.rotation.x -= 5 * yawnEnvelope * RAD;
        byName.head.rotation.z += (2.5 * Math.sin(yawn * Math.PI) - 1.5) * yawnEnvelope * RAD;
        root.position.y -= 2.2 * yawnEnvelope;
      }

      // Register the face before solving grounded limbs. Otherwise the approved
      // seated image reveals a head several pixels higher when its rig returns.
      var views = window.REFERENCE_MODEL.views;
      function facePoint(name) {
        var view = views[name];
        return viewPoint(name, view.rig.face[0] * view.size[0], view.rig.face[1] * view.size[1]);
      }
      var standFace = facePoint('stand-front'), sitFace = facePoint('sit-front');
      var sleepFace = facePoint('sleep-front');
      var desiredFace = [lerp(lerp(standFace[0], sitFace[0], s), sleepFace[0], smooth(.12, 1, h)),
        lerp(lerp(standFace[1], sitFace[1], s), sleepFace[1], smooth(.05, 1, h))];
      scene.updateMatrixWorld(true);
      var faceTransform = new THREE.Matrix4().multiplyMatrices(byName.head.matrixWorld,
        skeleton.boneInverses[bones.indexOf(byName.head)]);
      var rigFace = new THREE.Vector3(standFace[0], standFace[1], 0).applyMatrix4(faceTransform);
      root.position.x += desiredFace[0] - rigFace.x;
      root.position.y += desiredFace[1] - rigFace.y;
      root.position.y = Math.min(root.position.y, 215 - 5 * settle);
      scene.updateMatrixWorld(true);

      // Resolve joints from world-space targets so both limbs follow the pose
      // continuously without scaling or cross-fading complete character images.
      var sitFeet = ['L', 'R'].map(function (side) {
        return bindPoints['foot' + side].slice();
      });
      var sleepFeet = [[209, 227.752], [226, 227.752]];
      var legReach = smooth(.5, .98, h);
      ['L', 'R'].forEach(function (side) {
        var index = side === 'L' ? 0 : 1;
        var seatedFoot = [sitFeet[index][0] + (index === 0 ? -3 : 3) * smooth(.05, .8, s), sitFeet[index][1]];
        var foot = [lerp(seatedFoot[0], sleepFeet[index][0], legReach),
          lerp(seatedFoot[1], sleepFeet[index][1], legReach),
          36 * smooth(.08, .9, s) * (1 - smooth(.35, .9, h))];
        if (s > .001 || h > .001) {
          aimChain('thigh' + side, 'shin' + side, 'foot' + side, foot,
            side === 'L' ? 'left' : 'right', true);
          byName['foot' + side].quaternion.copy(byName['shin' + side]
            .getWorldQuaternion(new THREE.Quaternion()).invert());
        }
      });
      var sitHands = [[118, 164], [133, 164]];
      var sleepHands = [[86, 231], [123, 231]];
      ['L', 'R'].forEach(function (side) {
        var index = side === 'L' ? 0 : 1;
        var standHand = bindPoints['hand' + side].slice();
        var seatedHand = [lerp(standHand[0], sitHands[index][0], s),
          lerp(standHand[1] + 68 * s, sitHands[index][1], s)];
        var supportHand = [index === 0 ? 106 : 145, 216];
        var target = [lerp(lerp(seatedHand[0], supportHand[0], support), sleepHands[index][0], settle),
          lerp(lerp(seatedHand[1], supportHand[1], support), sleepHands[index][1], settle)];
        if (yawnEnvelope > .001 && s > .85 && h < .3) {
          // Keep the hands outside the face while the elbows open upward.
          var yawnHand = index === 0 ? [106, 151] : [149, 151];
          target = [lerp(target[0], yawnHand[0], yawnEnvelope),
            lerp(target[1], yawnHand[1], yawnEnvelope)];
        }
        if (s > .001 || h > .001) {
          aimChain('arm' + side, 'forearm' + side, 'hand' + side,
            target, side === 'L' ? 'left' : 'right', true);
        }
      });
      var sway = options.reducedMotion ? 0 : Math.sin(t * .9) * 1.2 * (1 - s) * (1 - h);
      rotation('hairL', sway); rotation('hairR', sway);
      if (s > .001 || h > .001) {
        // Articulated hair follows a smooth floor curve for both seated and prone poses.
        var sitHair = { L: [[40, 206], [34, 230], [66, 220]],
          R: [[138, 206], [222, 230], [190, 220]] };
        var sleepHair = { L: [[48, 212], [77, 220], [111, 220]],
          R: [[166, 212], [198, 220], [231, 220]] };
        ['L', 'R'].forEach(function (side) {
          ['hair', 'hairMid', 'hairTip'].forEach(function (prefix, index) {
            var bone = byName[prefix + side];
            var child = byName[['hairMid', 'hairTip', 'hairEnd'][index] + side];
            scene.updateMatrixWorld(true);
            var p = bone.getWorldPosition(new THREE.Vector3());
            var target = [lerp(sitHair[side][index][0], sleepHair[side][index][0], h),
              lerp(sitHair[side][index][1], sleepHair[side][index][1], h)];
            var length = child.position.length();
            var dx = target[0] - p.x, dy = target[1] - p.y, distance = Math.hypot(dx, dy);
            if (distance > length) { dx *= length / distance; dy *= length / distance; }
            var angle = Math.atan2(dy, dx) - worldAngle(bone.parent)
              - Math.atan2(child.position.y, child.position.x);
            bone.rotation.z = lerp(0, angle, smooth(.05, .9, Math.max(s, h)));
            bone.rotation.x = bone.rotation.y = 0;
          });
        });
      }
      scene.updateMatrixWorld(true);
      byName.tail.quaternion.copy(byName.tail.parent.getWorldQuaternion(new THREE.Quaternion()).invert())
        .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1),
          (-35 * s * (1 - h) + sway) * RAD));
      rotation('tailTip', lerp(4 * s, -5, h) + sway);
      var gesture = !options.reducedMotion ? options.gesture : null;
      var k = gesture ? clamp(gesture.k) : 0;
      var strength = gesture && gesture.strength != null ? clamp(gesture.strength) : 1;
      var e = Math.pow(Math.sin(k * Math.PI), 2) * strength * (1 - smooth(0, .15, s)) * (1 - h);
      if (gesture && e > 0) {
        if (gesture.kind === 'wave') {
          rotation('armR', -110 * e); rotation('forearmR', (-30 + 18 * Math.sin(k * Math.PI * 5)) * e);
          rotation('handR', 12 * Math.sin(k * Math.PI * 6) * e);
        } else if (gesture.kind === 'stretch') {
          rotation('armL', 135 * e); rotation('armR', -135 * e);
          rotation('forearmL', 18 * e); rotation('forearmR', -18 * e);
          root.position.y -= 2 * e;
        } else if (gesture.kind === 'nod') rotation('head', Math.sin(k * Math.PI * 4) * 7 * e);
        else if (gesture.kind === 'tilt') rotation('head', 9 * e);
        else if (gesture.kind === 'earTwitch') {
          rotation('earL', Math.sin(k * Math.PI * 6) * 10 * e);
          rotation('earR', -Math.sin(k * Math.PI * 6 + .5) * 10 * e);
        }
      }
      if (options.look && !options.reducedMotion) {
        byName.head.rotation.x += (Number(options.look[1]) || 0) * RAD;
        byName.head.rotation.y += (Number(options.look[0]) || 0) * RAD;
      }
      byName.head.rotation.y += (Number(options.gazeX) || 0) * 12 * RAD;
      parts.forEach(function (part) {
        part.mesh.renderOrder = part.spec.z;
        if (/^(forearm|hand)/.test(part.spec.name)) part.mesh.renderOrder = 25 + part.spec.z * .02;
      });
      scene.updateMatrixWorld(true); skeleton.update(); fitStageToCanvas();
    }
    var transform = new THREE.Matrix4();
    var skinPoint = new THREE.Vector3();
    function drawHair(part) {
      var geometry = part.mesh.geometry, positions = geometry.attributes.position, uv = geometry.attributes.uv;
      var vertices = [];
      for (var i = 0; i < positions.count; i++) {
        skinPoint.fromBufferAttribute(positions, i); part.mesh.applyBoneTransform(i, skinPoint);
        vertices.push({ x: skinPoint.x, y: skinPoint.y,
          u: uv.getX(i) * part.image.width, v: (1 - uv.getY(i)) * part.image.height });
      }
      var index = geometry.index.array;
      for (var j = 0; j < index.length; j += 3) {
        var p = vertices[index[j]], q = vertices[index[j + 1]], r = vertices[index[j + 2]];
        var u1 = q.u - p.u, v1 = q.v - p.v, u2 = r.u - p.u, v2 = r.v - p.v;
        var det = u1 * v2 - u2 * v1;
        if (Math.abs(det) < .0001) continue;
        var a = ((q.x - p.x) * v2 - (r.x - p.x) * v1) / det;
        var b = ((q.y - p.y) * v2 - (r.y - p.y) * v1) / det;
        var c = (u1 * (r.x - p.x) - u2 * (q.x - p.x)) / det;
        var d = (u1 * (r.y - p.y) - u2 * (q.y - p.y)) / det;
        fallback.save(); fallback.setTransform(pixelScale, 0, 0, pixelScale, overscan * pixelScale, overscan * pixelScale);
        fallback.beginPath(); fallback.moveTo(p.x, p.y); fallback.lineTo(q.x, q.y); fallback.lineTo(r.x, r.y);
        fallback.closePath(); fallback.clip();
        fallback.transform(a, b, c, d, p.x - a * p.u - c * p.v, p.y - b * p.u - d * p.v);
        fallback.drawImage(part.image, 0, 0); fallback.restore();
      }
    }
    function fallbackDraw() {
      fallback.clearRect(0, 0, 768, 768);
      parts.slice().sort(function (a, b) { return a.mesh.renderOrder - b.mesh.renderOrder; }).forEach(function (part) {
        if (part.articulatedSurface) { drawHair(part); return; }
        transform.multiplyMatrices(bones[part.boneIndex].matrixWorld, skeleton.boneInverses[part.boneIndex]);
        var m = transform.elements, r = part.rect;
        fallback.save(); fallback.setTransform(m[0] * pixelScale, m[1] * pixelScale, m[4] * pixelScale, m[5] * pixelScale,
          (m[12] + overscan) * pixelScale, (m[13] + overscan) * pixelScale);
        fallback.drawImage(part.image, r[0], r[1], r[2], r[3]); fallback.restore();
      });
    }
    function endpointKind(name, start) {
      return name === 'sit' ? (start ? 'stand' : 'sit')
        : name === 'lie' ? (start ? 'sit' : 'sleep')
        : name === 'wake' ? (start ? 'sleep' : 'stand') : 'stand';
    }
    function matchesPose(options, expected) {
      var s = clamp(options.sit), h = clamp(options.sleep);
      return expected === 'stand' ? s + h < .001
        : expected === 'sit' ? s > .999 && h < .001 : h > .999;
    }
    function snapshot() {
      if (!joinCanvas) { joinCanvas = document.createElement('canvas'); joinCanvas.width = joinCanvas.height = 768; }
      var ctx = joinCanvas.getContext('2d'); ctx.clearRect(0, 0, 768, 768);
      ctx.drawImage(canvas.style.opacity === '0' ? referenceCanvas : canvas, 0, 0);
    }
    function blendSnapshot(progress) {
      var mix = progress * progress * progress * (10 + progress * (-15 + 6 * progress));
      referenceContext.save();
      referenceContext.globalCompositeOperation = 'destination-in'; referenceContext.globalAlpha = mix;
      referenceContext.fillRect(0, 0, 768, 768);
      referenceContext.globalCompositeOperation = 'lighter'; referenceContext.globalAlpha = 1 - mix;
      referenceContext.drawImage(joinCanvas, 0, 0); referenceContext.restore();
      canvas.style.opacity = '0';
    }
    function draw(root, face, options) {
      if (disposed) return;
      var previousOptions = lastOptions;
      lastOptions = options || {};
      if (root && surface.parentNode !== root) { root.textContent = ''; root.appendChild(surface); }
      if (lost) return;
      if (motionPlayer) {
        var previousMotion = motionPlayer.info();
        motionPlayer.clear();
        var fullClip = lastOptions.wholeBodyWake != null ? 'wake'
          : clamp(lastOptions.sleep) > 0 && clamp(lastOptions.sleep) < 1 ? 'lie'
          : clamp(lastOptions.sit) > 0 && clamp(lastOptions.sit) < 1 ? 'sit'
          : clamp(lastOptions.sit) + clamp(lastOptions.sleep) < .001
            && lastOptions.gesture && lastOptions.gesture.kind === 'stretch' ? 'stretch' : '';
        var progress = fullClip === 'wake' ? lastOptions.wholeBodyWake : fullClip === 'sit' ? lastOptions.sit
          : fullClip === 'lie' ? lastOptions.sleep : fullClip ? lastOptions.gesture.k : 0;
        // Exact endpoints use the original reference renderer, including its
        // expressions and sleep respiration, rather than a resampled video pose.
        if (fullClip && (progress > 0 || fullClip === 'wake') && progress < 1 && !lastOptions.reducedMotion) {
          if (lastOptions.smoothJoins && hasDrawn && !previousMotion
              && (progress <= .02 || progress >= .98)
              && matchesPose(previousOptions, endpointKind(fullClip, progress <= .02))) {
            snapshot(); motionEntry = { start: performance.now(), clip: fullClip };
          }
          if (!lastOptions.smoothJoins || motionEntry && motionEntry.clip !== fullClip) motionEntry = null;
          referenceContext.clearRect(0, 0, 768, 768);
          if (motionPlayer.draw(referenceContext, fullClip, progress, 768, 768)) {
            if (motionEntry) {
              var entryProgress = clamp((performance.now() - motionEntry.start) / JOIN_MS);
              if (entryProgress >= 1) motionEntry = null; else blendSnapshot(entryProgress);
            }
            motionJoin = null;
            canvas.style.opacity = '0'; referenceBlend = { sit: 0, sleep: 0 }; rigDirty = true; hasDrawn = true; return;
          }
        }
        motionEntry = null;
        if (lastOptions.smoothJoins && !lastOptions.reducedMotion && previousMotion) {
          var clipInfo = window.DHA_WHOLE_MOTION.clips[previousMotion.clip];
          var atStart = previousMotion.progress <= .02 && previousMotion.frame <= (clipInfo.firstFrame || 0) + 1;
          var atEnd = previousMotion.progress >= .98 && previousMotion.frame >= clipInfo.frames - 2;
          var matches = matchesPose(lastOptions, endpointKind(previousMotion.clip, atStart));
          if ((atStart || atEnd) && matches) {
            snapshot();
            motionJoin = { start: performance.now() };
          }
        }
      }
      expression(lastOptions); pose(lastOptions);
      rigDirty = false;
      if (renderer) renderer.render(scene, camera); else fallbackDraw();
      var s = clamp(lastOptions.sit), h = clamp(lastOptions.sleep);
      var standFace = viewPoint('stand-front', window.REFERENCE_MODEL.views['stand-front'].rig.face[0] * 357,
        window.REFERENCE_MODEL.views['stand-front'].rig.face[1] * 545);
      var sitFace = viewPoint('sit-front', window.REFERENCE_MODEL.views['sit-front'].rig.face[0] * 262,
        window.REFERENCE_MODEL.views['sit-front'].rig.face[1] * 280);
      var sleepFace = viewPoint('sleep-front', window.REFERENCE_MODEL.views['sleep-front'].rig.face[0] * 362,
        window.REFERENCE_MODEL.views['sleep-front'].rig.face[1] * 219);
      var targetFace = [lerp(standFace[0], sitFace[0], s), lerp(standFace[1], sitFace[1], s)];
      if (h > 0) {
        var headTransform = new THREE.Matrix4().multiplyMatrices(byName.head.matrixWorld,
          skeleton.boneInverses[bones.indexOf(byName.head)]);
        var animatedFace = new THREE.Vector3(standFace[0], standFace[1], 0).applyMatrix4(headTransform);
        var endpoint = smooth(.9, 1, h);
        targetFace = [lerp(animatedFace.x, sleepFace[0], endpoint),
          lerp(animatedFace.y, sleepFace[1], endpoint)];
      }
      var sitAlpha = lastOptions.recoveringFromProne ? 0
        : smooth(.78, .99, s) * (1 - smooth(.02, .18, h));
      var visibleYawn = lastOptions.reducedMotion ? 0 : clamp(lastOptions.yawn);
      var yawnMix = visibleYawn > .001 && visibleYawn < .999
        ? Math.pow(Math.sin(visibleYawn * Math.PI), 2) * smooth(.85, 1, s) * (1 - smooth(.02, .3, h)) : 0;
      // Expose the skeletal seated pose while the hands are moving; the
      // static reference remains the exact endpoint at both sides of yawn.
      sitAlpha *= 1 - yawnMix;
      var sleepAlpha = smooth(.8, .98, h);
      referenceBlend = { sit: sitAlpha, sleep: sleepAlpha };
      var referenceStrength = Math.max(sitAlpha, sleepAlpha);
      canvas.style.opacity = referenceStrength > 0 ? '0' : '1';
      referenceContext.clearRect(0, 0, referenceCanvas.width, referenceCanvas.height);
      // Sum premultiplied contributions in one surface. Two source-over
      // canvases made an opaque character become translucent at the handoff.
      if (referenceStrength > 0) {
        referenceContext.globalAlpha = 1 - referenceStrength;
        referenceContext.drawImage(canvas, 0, 0);
        referenceContext.globalAlpha = 1;
      }
      referenceContext.globalCompositeOperation = 'lighter';
      drawReferencePose('sit-front', sitAlpha, lastOptions, targetFace);
      drawReferencePose('sleep-front', sleepAlpha, lastOptions, targetFace);
      referenceContext.globalCompositeOperation = 'source-over';
      if (!lastOptions.smoothJoins || lastOptions.reducedMotion) motionJoin = null;
      if (motionJoin) {
        var joinProgress = clamp((performance.now() - motionJoin.start) / JOIN_MS);
        if (joinProgress >= 1) motionJoin = null;
        else {
          if (!referenceStrength) referenceContext.drawImage(canvas, 0, 0);
          blendSnapshot(joinProgress);
        }
      }
      hasDrawn = true;
    }
    function contextLost(event) { if (!disposed) { event.preventDefault(); lost = true; } }
    function contextRestored() { if (!disposed) { lost = false; draw(null, null, lastOptions); } }
    canvas.addEventListener('webglcontextlost', contextLost);
    canvas.addEventListener('webglcontextrestored', contextRestored);
    function dispose() {
      if (disposed) return;
      motionJoin = motionEntry = null;
      if (joinCanvas) { joinCanvas.width = joinCanvas.height = 0; joinCanvas = null; }
      disposed = true;
      canvas.removeEventListener('webglcontextlost', contextLost);
      canvas.removeEventListener('webglcontextrestored', contextRestored);
      parts.forEach(function (part) { part.mesh.geometry.dispose(); part.mesh.material.dispose(); });
      textures.forEach(function (texture) { texture.dispose(); }); skeleton.dispose();
      if (motionPlayer) motionPlayer.dispose();
      releaseRenderer(); surface.remove(); expressionFrames = {};
    }
    function auditGeometry() {
      if (rigDirty) { expression(lastOptions); pose(lastOptions); rigDirty = false; }
      var rigidEdgeError = 0, invertedHairTriangles = 0, triangles = 0, bounds = [];
      parts.forEach(function (part) {
        var geometry = part.mesh.geometry, positions = geometry.attributes.position;
        var vertices = [], original = [], index = geometry.index.array;
        for (var i = 0; i < positions.count; i++) {
          var p = new THREE.Vector3().fromBufferAttribute(positions, i);
          original.push(p.clone()); part.mesh.applyBoneTransform(i, p); vertices.push(p);
        }
        var hair = part.spec.name === 'skin' || part.spec.name === 'hairL' || part.spec.name === 'hairR';
        bounds.push({ name: part.spec.name, minX: Math.min.apply(null, vertices.map(function(p) { return p.x; })),
          maxX: Math.max.apply(null, vertices.map(function(p) { return p.x; })),
          minY: Math.min.apply(null, vertices.map(function(p) { return p.y; })),
          maxY: Math.max.apply(null, vertices.map(function(p) { return p.y; })) });
        for (var j = 0; j < index.length; j += 3) {
          triangles++;
          var a = index[j], b = index[j + 1], c = index[j + 2];
          var p = vertices[a], q = vertices[b], r = vertices[c];
          var area = (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
          var u = original[a], v = original[b], w = original[c];
          var bindArea = (v.x - u.x) * (w.y - u.y) - (v.y - u.y) * (w.x - u.x);
          if (hair && area * bindArea < -1e-7) invertedHairTriangles++;
          if (!part.articulatedSurface) rigidEdgeError = Math.max(rigidEdgeError,
            Math.abs(p.distanceTo(q) - u.distanceTo(v)), Math.abs(p.distanceTo(r) - u.distanceTo(w)));
        }
      });
      return { rigidEdgeError: rigidEdgeError, invertedHairTriangles: invertedHairTriangles, triangles: triangles, bounds: bounds };
    }
    return { draw: draw, dispose: dispose, auditGeometry: auditGeometry,
      needsFrame: function () { return !!motionJoin || !!motionEntry; }, info: function () {
      if (rigDirty) { expression(lastOptions); pose(lastOptions); rigDirty = false; }
      return { id: model.id, sourceOnly: true, previousAssets: [], renderer: renderer ? 'three-skeleton' : 'canvas-skeleton',
        visibleRenderer: motionPlayer && motionPlayer.info() ? 'whole-body-frames' : 'reference-skeleton',
        boneAuditAppliesToVisibleFrame: !(motionPlayer && motionPlayer.info()),
        skeletal: true, bones: bones.length, layers: model.parts.length, poseImagesBlended: 0,
        referencePoses: true, views: Object.keys(window.REFERENCE_MODEL.views),
        referencePoseBlend: { sit: referenceBlend.sit || 0, sleep: referenceBlend.sleep || 0 },
        wholeBodyMotion: motionPlayer ? motionPlayer.info() : null,
        motionJoinActive: !!motionJoin,
        motionEntryActive: !!motionEntry,
        stageScale: stageScale, stageFit: stageFit,
        expression: lastOptions.expression || 'neutral', expressionMix: lastOptions.expressionMix == null ? 1 : lastOptions.expressionMix,
        gazeX: Number(lastOptions.gazeX) || 0,
        gesture: lastOptions.gesture ? lastOptions.gesture.kind : '',
        view: 'front',
        expressions: ['neutral'].concat(Object.keys(facialPatches)), expressionTextureCount: 1,
        joints: bones.map(function (bone) { var p = new THREE.Vector3(); bone.getWorldPosition(p);
          return { name: bone.name, parent: bone.parent && bone.parent.name || null, x: p.x, y: p.y, z: p.z,
            scale: [bone.scale.x, bone.scale.y, bone.scale.z] }; }) };
    } };
  }
  window.SkeletalCharacter = { create: create };
})();
