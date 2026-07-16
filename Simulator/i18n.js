/* Shared KO/EN language switcher for Physics Simulator pages */
(function () {
  var STORAGE_KEY = 'physics-sim-lang';

  function detectLang() {
    try {
      var saved = localStorage.getItem(STORAGE_KEY);
      if (saved === 'ko' || saved === 'en') return saved;
    } catch (e) {}
    var nav = (navigator.language || 'en').toLowerCase();
    return nav.indexOf('ko') === 0 ? 'ko' : 'en';
  }

  var style = document.createElement('style');
  style.textContent = [
    '.lang-switch{display:inline-flex;align-items:center;gap:0;border:1px solid rgba(159,179,214,.45);border-radius:999px;overflow:hidden;background:rgba(21,37,64,.25);}',
    '.lang-switch .lang-btn{appearance:none;border:0;background:transparent;color:#9FB3D6;font:700 12px/1 "Noto Sans KR",-apple-system,BlinkMacSystemFont,sans-serif;letter-spacing:.04em;padding:7px 12px;cursor:pointer;transition:background .15s ease,color .15s ease;}',
    '.lang-switch .lang-btn:hover{color:#fff;}',
    '.lang-switch .lang-btn.active{background:rgba(255,255,255,.14);color:#fff;}',
    'header .eyebrow-row{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;margin-bottom:16px;}',
    'header.page-head .header-top{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;margin-bottom:16px;}',
    'header.page-head .header-top .eyebrow{margin-bottom:0;}'
  ].join('');
  document.head.appendChild(style);

  window.SimI18n = {
    lang: detectLang(),
    messages: { en: {}, ko: {} },

    register: function (dict) {
      if (!dict) return this;
      ['en', 'ko'].forEach(function (lang) {
        if (!dict[lang]) return;
        Object.keys(dict[lang]).forEach(function (key) {
          SimI18n.messages[lang][key] = dict[lang][key];
        });
      });
      return this;
    },

    t: function (key) {
      var pack = this.messages[this.lang] || {};
      if (pack[key] != null) return pack[key];
      if (this.messages.en[key] != null) return this.messages.en[key];
      return key;
    },

    apply: function () {
      var self = this;
      document.documentElement.lang = this.lang === 'ko' ? 'ko' : 'en';

      document.querySelectorAll('[data-i18n]').forEach(function (el) {
        var key = el.getAttribute('data-i18n');
        var val = self.t(key);
        if (el.hasAttribute('data-i18n-html')) el.innerHTML = val;
        else el.textContent = val;
      });

      document.querySelectorAll('[data-i18n-attr]').forEach(function (el) {
        var spec = el.getAttribute('data-i18n-attr');
        if (!spec) return;
        spec.split(';').forEach(function (part) {
          var bits = part.split(':');
          if (bits.length < 2) return;
          var attr = bits[0].trim();
          var key = bits[1].trim();
          el.setAttribute(attr, self.t(key));
        });
      });

      document.querySelectorAll('.lang-btn').forEach(function (btn) {
        btn.classList.toggle('active', btn.getAttribute('data-lang') === self.lang);
        btn.setAttribute('aria-pressed', btn.getAttribute('data-lang') === self.lang ? 'true' : 'false');
      });

      window.dispatchEvent(new CustomEvent('sim-langchange', { detail: { lang: self.lang } }));
    },

    setLang: function (lang) {
      if (lang !== 'ko' && lang !== 'en') return;
      this.lang = lang;
      try { localStorage.setItem(STORAGE_KEY, lang); } catch (e) {}
      this.apply();
    },

    createSwitch: function () {
      var wrap = document.createElement('div');
      wrap.className = 'lang-switch';
      wrap.setAttribute('role', 'group');
      wrap.setAttribute('aria-label', 'Language');

      [['ko', '한글'], ['en', 'EN']].forEach(function (pair) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'lang-btn' + (SimI18n.lang === pair[0] ? ' active' : '');
        btn.setAttribute('data-lang', pair[0]);
        btn.setAttribute('aria-pressed', SimI18n.lang === pair[0] ? 'true' : 'false');
        btn.textContent = pair[1];
        btn.addEventListener('click', function () { SimI18n.setLang(pair[0]); });
        wrap.appendChild(btn);
      });
      return wrap;
    },

    mount: function (selector) {
      var host = typeof selector === 'string' ? document.querySelector(selector) : selector;
      if (!host) return null;
      if (host.querySelector('.lang-switch')) return host.querySelector('.lang-switch');
      var sw = this.createSwitch();
      host.appendChild(sw);
      return sw;
    },

    boot: function (opts) {
      opts = opts || {};
      if (opts.messages) this.register(opts.messages);
      var mountTo = opts.mount || '.lang-mount';
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () {
          SimI18n.mount(mountTo);
          SimI18n.apply();
        });
      } else {
        this.mount(mountTo);
        this.apply();
      }
    }
  };

  // Common strings shared across Simulator pages
  window.SimI18n.register({
    en: {
      'common.eyebrow': 'Physics Simulator',
      'common.open': 'Open',
      'common.comingSoon': 'Coming soon'
    },
    ko: {
      'common.eyebrow': '물리학 시뮬레이터',
      'common.open': '열기',
      'common.comingSoon': '준비 중'
    }
  });
})();
