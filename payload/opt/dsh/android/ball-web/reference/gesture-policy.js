(function () {
  'use strict';
  var others = ['earTwitch', 'nod', 'tilt', 'wave'];
  var stretchProbability = .15;
  window.DHA_GESTURE_POLICY = {
    kinds: others.concat(['stretch']),
    stretchProbability: stretchProbability,
    wakeStretchProbability: .2,
    shouldWakeStretch: function (random) {
      return Math.max(0, Math.min(1, Number(random) || 0)) < .2;
    },
    pick: function (random) {
      var value = Math.max(0, Math.min(.999999999, Number(random) || 0));
      return value < stretchProbability ? 'stretch' : others[Math.min(others.length - 1,
        Math.floor((value - stretchProbability) / (1 - stretchProbability) * others.length))];
    }
  };
})();
