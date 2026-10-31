// 二狗的原生桥在网页这一侧的垫片（349 号票，安全设计见 docs/adr/0040）。
// App 用 WebViewCompat.addDocumentStartJavaScript 注入它、用 addWebMessageListener 给它一个通道对象，两者都只对配好的二狗来源：
// 外部网页、别的来源的 iframe 里既没有这段脚本，也没有通道。不用 addJavascriptInterface——那个对象所有页面和框架都看得见，调用时还分不清谁调的。
// 网页（packages/web/src/app/native*.ts）照鸿蒙的样子同步调 ergoNative：
// - mirror：要同步拿到值的几个（版本号、底部避让、通知状态……），读这里记着的那一份（App 开场写进 boot，变了推过来）；
// - fire：不要结果，发过去就回；
// - promise：要等结果的，回 Promise<string>。
// App 回话、推消息走通道的回信（JavaScriptReplyProxy，只送回发信的这个框架）。这个文件不进打包工具，语法照老 WebView 能跑的写。
(function () {
  'use strict';
  // 只给主框架：同来源的 iframe 里 App 也会核对 isMainFrame 拒掉，这里干脆不装
  if (window.top !== window) return;
  var channel = window.__ergoChannel;
  if (!channel || window.ergoNative) return;

  /* App 注入前把这一行换成 { version, side, methods: { mirror, fire, promise }, mirror: {...} } */
  var boot = /*__ERGO_BOOT__*/ null;
  if (!boot) return;

  var mirror = boot.mirror || {};
  var waiting = {};
  var nextId = 1;
  var contacted = false;

  function post(method, args, id) {
    var message = { m: method, a: args || [] };
    if (id) message.id = id;
    channel.postMessage(JSON.stringify(message));
  }

  /** 网页第一次调过来：是二狗的网页（App 据此不提示"这不是二狗？"） */
  function contact() {
    if (contacted) return;
    contacted = true;
    post('__contact');
  }

  function argsOf(list) {
    return Array.prototype.slice.call(list);
  }

  /** 要同步回值的几个：读记着的那一份，需要时再告诉 App */
  var mirrorMethods = {
    appVersion: function () {
      return boot.version;
    },
    safeArea: function () {
      return mirror.safeArea || '';
    },
    notifyState: function () {
      return mirror.notify || '';
    },
    notifyTakeOpen: function () {
      var opened = mirror.open || '';
      mirror.open = '';
      // 带上取走的是哪一条：取的时候 App 又记下了新的，新的不能被这一下清掉
      if (opened) post('notifyTakeOpen', [opened]);
      return opened;
    },
    notifyResetAsked: function () {
      post('notifyResetAsked');
      try {
        var state = JSON.parse(mirror.notify || '{}');
        state.asked = false;
        mirror.notify = JSON.stringify(state);
      } catch (e) {
        mirror.notify = '';
      }
      return mirror.notify;
    },
    browserAttach: function () {
      post('browserAttach');
      return mirror.browser || '';
    },
    setTexts: function (json) {
      post('setTexts', [json]);
      return typeof json === 'string' ? 'ok' : '';
    },
  };

  var api = {};
  boot.methods.mirror.forEach(function (name) {
    var run = mirrorMethods[name];
    api[name] = function () {
      contact();
      return run.apply(null, arguments);
    };
  });
  boot.methods.fire.forEach(function (name) {
    api[name] = function () {
      contact();
      post(name, argsOf(arguments));
    };
  });
  boot.methods.promise.forEach(function (name) {
    api[name] = function () {
      contact();
      var args = argsOf(arguments);
      return new Promise(function (resolve) {
        var id = nextId++;
        waiting[id] = resolve;
        post(name, args, id);
      });
    };
  });
  Object.freeze(api);

  /** App 能调的网页函数：只有这几个（新名字没有时用旧名字，见 packages/web/src/app/app-names.ts） */
  var PAGE_FUNCTIONS = {
    __ergoBack: '__ergouBack',
    __ergoInsets: '__ergouInsets',
    __ergoVoice: '__ergouVoice',
    __ergoBrowser: '__ergouBrowser',
    __ergoNotifyOpen: '__ergouNotifyOpen',
    __ergoSide: '__ergouSide',
  };

  channel.onmessage = function (event) {
    var message;
    try {
      message = JSON.parse(event.data);
    } catch (e) {
      return;
    }
    if (message.t === 'r') {
      var resolve = waiting[message.id];
      delete waiting[message.id];
      if (resolve) resolve(message.v);
      return;
    }
    if (message.t === 'm') {
      mirror[message.k] = message.v;
      // 用户点开了通知栏里的一条：叫网页来取；网页还没登记（还在加载）的，开场会自己取
      if (message.k === 'open' && message.v) callPage('__ergoNotifyOpen');
      return;
    }
    if (message.t === 'c' && Object.prototype.hasOwnProperty.call(PAGE_FUNCTIONS, message.f)) callPage(message.f, message.a);
  };

  function callPage(name, arg) {
    var fn = window[name] || window[PAGE_FUNCTIONS[name]];
    if (typeof fn !== 'function') return;
    if (arg === undefined) fn();
    else fn(arg);
  }

  function expose(name, value) {
    Object.defineProperty(window, name, { value: value, writable: false, configurable: false, enumerable: false });
  }
  expose('ergoNative', api);
  expose('ergouNative', api);

  // 侧边栏那个 WebView 的网页多一个 window.ergoSide（收起、取消选中、起来了）
  if (boot.side) {
    var side = Object.freeze({
      close: function () {
        post('side.close');
      },
      clearSelection: function () {
        post('side.clearSelection');
      },
      ready: function () {
        post('side.ready');
      },
    });
    expose('ergoSide', side);
    expose('ergouSide', side);
  }

  // 告诉 App 新页面起来了：App 记下回信的通道，把开场之后变了的值再推一次
  post('__hello');
})();
