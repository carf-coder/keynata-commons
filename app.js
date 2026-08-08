/* ============================================================
   Keynata Commons — 一覧描画・試聴・フィルタ
   依存ライブラリなし。release/index.json を唯一の入力とする。

   数え方: 1行=1作品(=1シード)。カラオケのように guide/karaoke の2版がある
   作品も1行にまとめ、行の中で版ごとに再生とダウンロードを並べる。
   曲数・フィルタ件数はすべて作品数で数える。
   ============================================================ */

(function () {
  "use strict";

  /* release/ の位置。公開リポジトリでは site/ の中身がルートに来るので "release"、
     このリポジトリでローカル確認するときは site/ の隣なので "../release"。
     両方試して先に見つかった方を使う。 */
  var RELEASE_CANDIDATES = ["../release", "release"];

  /* ブラウザ内合成(Synth)で使う自己ホスト資産。外部CDNは一切参照しない。
     bytes は進捗バーの分母。実配布ファイルの実測値で、Content-Length が
     取れたときはそちらを優先する。 */
  var SYNTH_ASSETS = {
    lib: "vendor/spessasynth.min.js",
    worklet: "vendor/spessasynth_processor.min.js",
    banks: [
      /* 一般GM音色。WAV/MP3のレンダリングに使ったものと同じ版 */
      { id: "gm", url: "assets/GeneralUser-GS.sf2", bytes: 32319396 },
      /* 弦(GM 40-43)だけを上書きする小さな追加バンク。古典派のレンダリングでも
         同じ重ね方(弦を優先)をしているので、MP3と音色が揃う */
      { id: "strings", url: "assets/040_Florestan_String_Quartet.sf2", bytes: 3176318 }
    ],
    /* 先に置いたものが優先。fluidsynth の後ロード優先スタックと同じ並び */
    priority: ["strings", "gm"]
  };

  /* 合奏で5系統が同時に鳴るとピークが立つので、出力に少し余裕を持たせる */
  var SYNTH_GAIN = 0.7;

  var CATEGORY_LABELS = {
    rock_standard: "Rock Standard",
    rock_intense: "Rock Intense",
    jpop_3piece: "J-Pop Three-Piece",
    karaoke: "Karaoke"
  };

  var VERSION_LABELS = {
    main: "",
    guide: "Guide",
    karaoke: "Karaoke"
  };

  /* 2版の中身の説明(J4a: guide=ピアノ主旋律入り / karaoke=主旋律なし伴奏のみ) */
  var VERSION_GLOSSES = {
    guide: "with piano melody",
    karaoke: "backing only, ready to sing over"
  };

  /* 形式・進行はエンジン内部の識別子なので、聞き手の言葉に直して出す */
  var FORM_LABELS = {
    standard: "Verse-chorus",
    jpop_full_3piece: "J-Pop full form",
    jpop_full_karaoke: "J-Pop full form",
    /* 古典派の形式名も内部識別子のまま出さない(PUB2 S4差し戻しA3と同じ原則) */
    AB: "Binary (AB)",
    ABA: "Ternary (ABA)",
    RONDO5: "Rondo (ABACA)",
    RONDO7: "Rondo (ABACABA)",
    SONATINA: "Sonatina"
  };

  var PROGRESSION_LABELS = {
    royal_road: "Royal Road (IV-V-iii-vi)",
    komuro: "Komuro (vi-IV-V-I)"
  };

  var el = {
    list: document.getElementById("track-list"),
    status: document.getElementById("list-status"),
    filters: document.getElementById("filter-bar"),
    statTracks: document.getElementById("stat-tracks"),
    footerEngine: document.getElementById("footer-engine")
  };

  var audio = new Audio();
  audio.preload = "none";

  var state = {
    base: null,
    works: [],
    filter: "all",
    playingId: null,
    /* "mp3" か "synth"。どちらの経路で鳴っていても排他は共通に効かせる */
    mode: null
  };

  /* AudioWorklet が無いブラウザでは Synth を出さない(MP3経路は無傷のまま) */
  var SYNTH_SUPPORTED =
    typeof window.AudioContext === "function" &&
    typeof window.AudioWorkletNode === "function";

  var synth = {
    status: "idle",   // idle | loading | ready | failed
    ready: null,      // 読み込み中/完了の Promise
    ctx: null,
    node: null,       // WorkletSynthesizer
    seq: null,        // Sequencer
    raf: 0,
    onProgress: null, // 読み込み中の表示先(0..1 を受ける)
    request: 0        // 読み込み中に別の曲を押されたとき、古い方を捨てる印
  };

  /* --- 表示用の小道具 ---------------------------------------------------- */

  function titleCase(value) {
    return String(value)
      .split("_")
      .map(function (w) { return w.charAt(0).toUpperCase() + w.slice(1); })
      .join(" ");
  }

  function categoryLabel(id) {
    return CATEGORY_LABELS[id] || titleCase(id);
  }

  /* 「Verse-chorus · 52 bars」。小節数は metadata.json にしかないので後から足す */
  function formLabel(track) {
    var label = FORM_LABELS[track.form] || titleCase(track.form);
    if (typeof track.n_measures === "number") {
      label += " · " + track.n_measures + " bars";
    }
    return label;
  }

  function progressionLabel(value) {
    return PROGRESSION_LABELS[value] || titleCase(value);
  }

  /* 主音は metadata に無いので調名は名乗らない。転調は起きていることをそのまま書く */
  function keyLabel(track) {
    var mode = track.mode ? String(track.mode) : "";
    var label = mode ? mode.charAt(0).toUpperCase() + mode.slice(1) : "Unknown";
    var shift = track.modulation_semitones;
    if (shift) {
      label += ", final-chorus key change " + (shift > 0 ? "+" : "−") + Math.abs(shift);
    }
    return label;
  }

  function duration(seconds) {
    if (typeof seconds !== "number" || !isFinite(seconds)) return "—";
    var total = Math.round(seconds);
    var m = Math.floor(total / 60);
    var s = total % 60;
    return m + ":" + (s < 10 ? "0" : "") + s;
  }

  function fileSize(bytes) {
    if (typeof bytes !== "number" || !isFinite(bytes)) return "";
    if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + " MB";
    return Math.max(1, Math.round(bytes / 1024)) + " KB";
  }

  function text(tag, className, value) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (value !== undefined && value !== null) node.textContent = value;
    return node;
  }

  /* --- データ取得 -------------------------------------------------------- */

  function loadIndex() {
    var attempt = 0;

    function tryNext() {
      if (attempt >= RELEASE_CANDIDATES.length) {
        return Promise.reject(new Error("index.json not found"));
      }
      var base = RELEASE_CANDIDATES[attempt++];
      return fetch(base + "/index.json", { cache: "no-cache" })
        .then(function (res) {
          if (!res.ok) throw new Error("HTTP " + res.status);
          return res.json().then(function (data) {
            state.base = base;
            return data;
          });
        })
        .catch(tryNext);
    }

    return tryNext();
  }

  /* 1トラック=1作品。versions を行の中の「版」に開く */
  function toWork(track) {
    var versions = Array.isArray(track.versions) && track.versions.length ? track.versions : ["main"];
    var known = Array.isArray(track.files) ? track.files : [];

    var renditions = versions.map(function (version) {
      var stem = version === "main" ? track.track_id : track.track_id + "_" + version;
      function pick(ext) {
        var name = stem + "." + ext;
        return known.indexOf(name) === -1 ? null : name;
      }
      return {
        id: track.track_id + "/" + version,
        version: version,
        label: VERSION_LABELS[version] !== undefined ? VERSION_LABELS[version] : titleCase(version),
        mp3: pick("mp3"),
        wav: pick("wav"),
        midi: pick("mid"),
        sizes: {}
      };
    });

    return {
      id: track.track_id,
      track: track,
      name: categoryLabel(track.category) + " No. " + track.seed,
      renditions: renditions,
      multi: renditions.length > 1
    };
  }

  function assetUrl(work, file) {
    return state.base + "/tracks/" + work.id + "/" + file;
  }

  /* metadata.json は小節数とファイルサイズを持っている。描画後に追いかけて表示へ足す。
     取得に失敗しても一覧の機能は落とさない。 */
  function enrich() {
    state.works.forEach(function (work) {
      fetch(state.base + "/tracks/" + work.id + "/metadata.json", { cache: "no-cache" })
        .then(function (res) { return res.ok ? res.json() : null; })
        .then(function (meta) {
          if (!meta) return;

          if (typeof meta.n_measures === "number") {
            work.track.n_measures = meta.n_measures;
            var formCell = document.querySelector('[data-form="' + work.id + '"]');
            if (formCell) formCell.textContent = formLabel(work.track);
          }

          if (!Array.isArray(meta.files)) return;
          var byName = {};
          meta.files.forEach(function (f) { byName[f.name] = f.bytes; });
          work.renditions.forEach(function (r) {
            ["wav", "midi"].forEach(function (kind) {
              var file = r[kind];
              if (!file || byName[file] === undefined) return;
              r.sizes[kind] = byName[file];
              var node = document.querySelector('[data-size="' + r.id + ":" + kind + '"]');
              if (node) node.textContent = fileSize(byName[file]);
            });
          });
        })
        .catch(function () { /* 補助情報なので握りつぶす */ });
    });
  }

  /* --- 描画 -------------------------------------------------------------- */

  function renderFilters() {
    var counts = {};
    state.works.forEach(function (w) {
      counts[w.track.category] = (counts[w.track.category] || 0) + 1;
    });

    var entries = [["all", "All", state.works.length]].concat(
      Object.keys(counts).sort().map(function (id) {
        return [id, categoryLabel(id), counts[id]];
      })
    );

    el.filters.textContent = "";
    entries.forEach(function (entry) {
      var button = document.createElement("button");
      button.type = "button";
      button.className = "filter-button" + (entry[0] === state.filter ? " is-current" : "");
      button.setAttribute("aria-pressed", entry[0] === state.filter ? "true" : "false");
      button.appendChild(document.createTextNode(entry[1]));
      button.appendChild(text("span", "count", entry[2]));
      button.addEventListener("click", function () {
        state.filter = entry[0];
        renderFilters();
        renderList();
      });
      el.filters.appendChild(button);
    });
  }

  function metaItem(key, value, dataKey, workId) {
    var wrap = text("div", null);
    wrap.appendChild(text("span", "meta-key", key));
    var v = text("span", "meta-value", value);
    if (dataKey) v.dataset[dataKey] = workId;
    wrap.appendChild(v);
    return wrap;
  }

  function playButton(work, rendition) {
    var button = document.createElement("button");
    button.type = "button";
    button.className = "track-play";
    button.dataset.play = rendition.id;
    button.appendChild(text("span", "glyph"));
    button.setAttribute("aria-label", "Play " + work.name + (rendition.label ? ", " + rendition.label : ""));
    button.disabled = !rendition.mp3;
    button.addEventListener("click", function () { toggle(work, rendition); });
    return button;
  }

  function downloadLink(work, rendition, kind, label) {
    var file = kind === "wav" ? rendition.wav : rendition.midi;
    if (!file) return null;
    var a = document.createElement("a");
    a.className = "dl";
    a.href = assetUrl(work, file);
    a.setAttribute("download", "");
    a.appendChild(document.createTextNode(label));
    var size = text("span", "size", fileSize(rendition.sizes[kind]));
    size.dataset.size = rendition.id + ":" + kind;
    a.appendChild(size);
    a.setAttribute("aria-label", "Download " + label + " — " + work.name +
      (rendition.label ? ", " + rendition.label : ""));
    return a;
  }

  /* Synthは主役ではない。DLボタンと同じ地味な枠に収める(minor UI) */
  function synthButton(work, rendition) {
    var button = document.createElement("button");
    button.type = "button";
    button.className = "dl dl-synth";
    button.dataset.synth = rendition.id;
    button.appendChild(document.createTextNode("Synth"));
    button.setAttribute("aria-pressed", "false");
    button.setAttribute("aria-label", "Play " + work.name +
      (rendition.label ? ", " + rendition.label : "") + " with the built-in synthesizer");
    button.addEventListener("click", function () { toggleSynth(work, rendition); });
    return button;
  }

  function actionsFor(work, rendition) {
    var actions = text("div", "track-actions");
    if (SYNTH_SUPPORTED && rendition.midi) actions.appendChild(synthButton(work, rendition));
    var wav = downloadLink(work, rendition, "wav", "WAV");
    var midi = downloadLink(work, rendition, "midi", "MIDI");
    if (wav) actions.appendChild(wav);
    if (midi) actions.appendChild(midi);
    return actions;
  }

  function progressFor(rendition) {
    var progress = text("div", "track-progress");
    progress.dataset.progress = rendition.id;
    progress.appendChild(document.createElement("span"));
    return progress;
  }

  /* 楽器の初回読み込み中だけ出す一段。再生位置バーと同じフェルトの文法で組み、
     「まだ何も鳴っていないが進んでいる」ことを同じ語彙で見せる。 */
  function loadBarFor(rendition) {
    var wrap = text("div", "synth-load");
    wrap.dataset.load = rendition.id;
    wrap.hidden = true;

    var label = text("div", "synth-load-label");
    label.appendChild(text("span", null, "Preparing instruments"));
    var pct = text("span", "synth-load-pct tabular", "0%");
    label.appendChild(pct);
    wrap.appendChild(label);

    var bar = text("div", "synth-load-bar");
    bar.appendChild(document.createElement("span"));
    wrap.appendChild(bar);
    return wrap;
  }

  function renderRow(work) {
    var track = work.track;
    var li = document.createElement("li");
    li.className = "track" + (work.multi ? " is-multi" : "");
    li.dataset.track = work.id;

    var title = text("div", "track-title");
    title.appendChild(text("h3", "track-name", work.name));
    li.appendChild(title);

    var meta = text("div", "track-meta");
    meta.appendChild(metaItem("BPM", Math.round(track.bpm)));
    meta.appendChild(metaItem("Form", formLabel(track), "form", work.id));
    meta.appendChild(metaItem("Key", keyLabel(track)));
    if (track.declared_progression) {
      meta.appendChild(metaItem("Progression", progressionLabel(track.declared_progression)));
    }
    meta.appendChild(metaItem("Length", duration(track.duration_seconds)));
    meta.appendChild(metaItem("Seed", track.seed));
    li.appendChild(meta);

    if (work.multi) {
      // 2版ある作品: 行の中に版ごとの一段を積む
      var versions = text("ul", "versions");
      work.renditions.forEach(function (r) {
        var line = document.createElement("li");
        line.className = "rendition";
        line.dataset.rendition = r.id;
        line.appendChild(playButton(work, r));
        line.appendChild(text("span", "version-name", r.label));
        if (VERSION_GLOSSES[r.version]) {
          line.appendChild(text("span", "version-gloss", VERSION_GLOSSES[r.version]));
        }
        line.appendChild(actionsFor(work, r));
        line.appendChild(progressFor(r));
        if (SYNTH_SUPPORTED && r.midi) line.appendChild(loadBarFor(r));
        versions.appendChild(line);
      });
      li.appendChild(versions);
    } else {
      var only = work.renditions[0];
      li.appendChild(playButton(work, only));
      li.appendChild(actionsFor(work, only));
      li.appendChild(progressFor(only));
      if (SYNTH_SUPPORTED && only.midi) li.appendChild(loadBarFor(only));
    }

    return li;
  }

  function groupHead(category) {
    var li = document.createElement("li");
    li.className = "group-head";
    li.setAttribute("role", "presentation");
    li.appendChild(text("span", "eyebrow", categoryLabel(category)));
    return li;
  }

  function renderList() {
    var rows = state.works.filter(function (w) {
      return state.filter === "all" || w.track.category === state.filter;
    });

    el.list.textContent = "";
    var lastCategory = null;
    rows.forEach(function (w) {
      // 全件表示のときだけカテゴリの見出しで区切る(絞り込み中は自明なので出さない)
      if (state.filter === "all" && w.track.category !== lastCategory) {
        el.list.appendChild(groupHead(w.track.category));
        lastCategory = w.track.category;
      }
      el.list.appendChild(renderRow(w));
    });

    if (!rows.length) {
      el.status.hidden = false;
      el.status.textContent = "No tracks in this category yet.";
    } else {
      el.status.hidden = true;
    }

    if (state.playingId) markPlaying(state.playingId);
  }

  /* --- 再生(常に1版だけ) ---------------------------------------------- */

  function relabel(button, from, to) {
    var label = button.getAttribute("aria-label") || "";
    button.setAttribute("aria-label", label.replace(new RegExp("^" + from + " "), to + " "));
  }

  function clearPlaying() {
    state.playingId = null;
    state.mode = null;
    stopSynthClock();
    Array.prototype.forEach.call(el.list.querySelectorAll(".is-playing"), function (node) {
      node.classList.remove("is-playing");
      node.classList.remove("via-synth");
    });
    Array.prototype.forEach.call(el.list.querySelectorAll(".track-progress span"), function (bar) {
      bar.style.width = "0%";
    });
    Array.prototype.forEach.call(el.list.querySelectorAll(".track-play"), function (button) {
      relabel(button, "Pause", "Play");
    });
    Array.prototype.forEach.call(el.list.querySelectorAll(".dl-synth"), function (button) {
      button.classList.remove("is-active");
      button.setAttribute("aria-pressed", "false");
    });
  }

  function markPlaying(id) {
    Array.prototype.forEach.call(el.list.querySelectorAll(".is-playing"), function (node) {
      node.classList.remove("is-playing");
      node.classList.remove("via-synth");
    });
    Array.prototype.forEach.call(el.list.querySelectorAll(".track-play"), function (button) {
      relabel(button, "Pause", "Play");
    });
    Array.prototype.forEach.call(el.list.querySelectorAll(".dl-synth"), function (button) {
      button.classList.remove("is-active");
      button.setAttribute("aria-pressed", "false");
    });

    var current = el.list.querySelector('[data-play="' + id + '"]');
    if (!current) return;
    if (state.mode === "mp3") relabel(current, "Play", "Pause");

    if (state.mode === "synth") {
      var toggleButton = el.list.querySelector('[data-synth="' + id + '"]');
      if (toggleButton) {
        toggleButton.classList.add("is-active");
        toggleButton.setAttribute("aria-pressed", "true");
      }
    }

    /* 合成で鳴っているときは丸い再生ボタンを「停止」の見た目にしない。
       あれはMP3の入口のままで、押せばMP3に切り替わるのが正しい振る舞いだから。 */
    var row = current.closest(".track");
    if (row) {
      row.classList.add("is-playing");
      if (state.mode === "synth") row.classList.add("via-synth");
    }
    var line = current.closest(".rendition");
    if (line) {
      line.classList.add("is-playing");
      if (state.mode === "synth") line.classList.add("via-synth");
    }
  }

  /* いま鳴っているものを、経路を問わず必ず1つに保つ */
  function stopEverything() {
    audio.pause();
    if (synth.seq && !synth.seq.paused) synth.seq.pause();
    /* 読み込み待ちの再生予約も無効にする(待っている間にMP3を押されたら、
       あとから合成が割り込んで二重に鳴らないように) */
    synth.request++;
    hideAllLoading();
    clearPlaying();
  }

  function toggle(work, rendition) {
    if (state.playingId === rendition.id && state.mode === "mp3" && !audio.paused) {
      audio.pause();
      clearPlaying();
      return;
    }
    if (!rendition.mp3) return;
    stopEverything();
    audio.src = assetUrl(work, rendition.mp3);
    state.playingId = rendition.id;
    state.mode = "mp3";
    markPlaying(rendition.id);
    audio.play().catch(function () {
      clearPlaying();
      el.status.hidden = false;
      el.status.textContent = "This preview could not be played. The download links still work.";
    });
  }

  audio.addEventListener("timeupdate", function () {
    if (!state.playingId || state.mode !== "mp3" || !audio.duration) return;
    var bar = el.list.querySelector('[data-progress="' + state.playingId + '"] span');
    if (bar) bar.style.width = (audio.currentTime / audio.duration) * 100 + "%";
  });

  audio.addEventListener("ended", clearPlaying);
  audio.addEventListener("error", function () {
    if (state.mode === "mp3" && state.playingId) clearPlaying();
  });

  /* --- ブラウザ内合成(Synth) --------------------------------------------

     MP3が既定の試聴で、こちらは「MIDIをその場で鳴らす」もう一つの経路。
     合成器一式と楽器の音は35MBあるので、Synthが初めて押されるまで1バイトも
     取りに行かない。読み終えたあとは全曲すぐ鳴る。
     読み込むファイルはすべて同一オリジンの自己ホスト。外部CDNは使わない。
     ---------------------------------------------------------------------- */

  function loadScriptOnce(url) {
    return new Promise(function (resolve, reject) {
      var tag = document.createElement("script");
      tag.src = url;
      tag.onload = function () { resolve(); };
      tag.onerror = function () { reject(new Error("failed to load " + url)); };
      document.head.appendChild(tag);
    });
  }

  /* 進捗を出したいので arrayBuffer() ではなくストリームを自分で読む。
     ストリームが使えない環境では黙って一括取得に落とす(進捗は飛ぶ)。 */
  function fetchWithProgress(url, onChunk) {
    return fetch(url, { cache: "force-cache" }).then(function (res) {
      if (!res.ok) throw new Error("HTTP " + res.status + " for " + url);
      if (!res.body || typeof res.body.getReader !== "function") {
        return res.arrayBuffer();
      }
      var reader = res.body.getReader();
      var chunks = [];
      var total = 0;
      return (function pump() {
        return reader.read().then(function (result) {
          if (result.done) {
            var out = new Uint8Array(total);
            var at = 0;
            chunks.forEach(function (c) { out.set(c, at); at += c.length; });
            return out.buffer;
          }
          chunks.push(result.value);
          total += result.value.length;
          onChunk(result.value.length);
          return pump();
        });
      })();
    });
  }

  function reportProgress(fraction) {
    if (synth.onProgress) synth.onProgress(Math.max(0, Math.min(1, fraction)));
  }

  /* 進捗の配分: ライブラリ 0-6% / 楽器の中身 6-94% / 組み立て 94-100% */
  function prepareSynth() {
    if (synth.ready) return synth.ready;
    synth.status = "loading";

    var totalBytes = SYNTH_ASSETS.banks.reduce(function (sum, b) { return sum + b.bytes; }, 0);
    var loadedBytes = 0;

    synth.ready = loadScriptOnce(SYNTH_ASSETS.lib)
      .then(function () {
        reportProgress(0.06);
        return Promise.all(SYNTH_ASSETS.banks.map(function (bank) {
          return fetchWithProgress(bank.url, function (n) {
            loadedBytes += n;
            reportProgress(0.06 + 0.88 * (loadedBytes / totalBytes));
          }).then(function (buffer) {
            return { id: bank.id, buffer: buffer };
          });
        }));
      })
      .then(function (banks) {
        reportProgress(0.94);
        var Lib = window.SpessaSynthLib;
        if (!Lib) throw new Error("synthesis library did not register");

        var ctx = new window.AudioContext();
        return ctx.audioWorklet.addModule(SYNTH_ASSETS.worklet).then(function () {
          var node = new Lib.WorkletSynthesizer(ctx);
          var gain = ctx.createGain();
          gain.gain.value = SYNTH_GAIN;
          node.connect(gain);
          gain.connect(ctx.destination);
          return node.isReady.then(function () {
            /* 逐次に足す(並列に足すとworklet側の並びが決まらない) */
            return banks.reduce(function (chain, bank) {
              return chain.then(function () {
                return node.soundBankManager.addSoundBank(bank.buffer, bank.id);
              });
            }, Promise.resolve()).then(function () {
              node.soundBankManager.priorityOrder = SYNTH_ASSETS.priority;
              var seq = new Lib.Sequencer(node);
              seq.loopCount = 0;
              seq.eventHandler.addEvent("songEnded", "commons-song-ended", function () {
                if (state.mode === "synth") clearPlaying();
              });
              synth.ctx = ctx;
              synth.node = node;
              synth.seq = seq;
              synth.status = "ready";
              reportProgress(1);
            });
          });
        });
      })
      .catch(function (error) {
        synth.status = "failed";
        synth.ready = null;
        throw error;
      });

    return synth.ready;
  }

  function hideAllLoading() {
    synth.onProgress = null;
    Array.prototype.forEach.call(el.list.querySelectorAll(".synth-load"), function (box) {
      box.hidden = true;
      var bar = box.querySelector(".synth-load-bar span");
      var pct = box.querySelector(".synth-load-pct");
      if (bar) bar.style.width = "0%";
      if (pct) pct.textContent = "0%";
    });
  }

  function showLoading(rendition) {
    var box = el.list.querySelector('[data-load="' + rendition.id + '"]');
    if (!box) return function () {};
    box.hidden = false;
    var bar = box.querySelector(".synth-load-bar span");
    var pct = box.querySelector(".synth-load-pct");
    synth.onProgress = function (fraction) {
      if (bar) bar.style.width = fraction * 100 + "%";
      if (pct) pct.textContent = Math.round(fraction * 100) + "%";
    };
    return function () {
      synth.onProgress = null;
      box.hidden = true;
      if (bar) bar.style.width = "0%";
      if (pct) pct.textContent = "0%";
    };
  }

  function stopSynthClock() {
    if (synth.raf) {
      window.cancelAnimationFrame(synth.raf);
      synth.raf = 0;
    }
  }

  function startSynthClock(id) {
    stopSynthClock();
    var bar = el.list.querySelector('[data-progress="' + id + '"] span');
    (function tick() {
      if (state.mode !== "synth" || state.playingId !== id || !synth.seq) return;
      var length = synth.seq.duration;
      if (bar && length) {
        bar.style.width = Math.min(1, synth.seq.currentTime / length) * 100 + "%";
      }
      synth.raf = window.requestAnimationFrame(tick);
    })();
  }

  function synthFailed(message) {
    el.status.hidden = false;
    el.status.textContent = message;
  }

  function toggleSynth(work, rendition) {
    if (state.playingId === rendition.id && state.mode === "synth" && synth.seq && !synth.seq.paused) {
      synth.seq.pause();
      clearPlaying();
      return;
    }
    if (!rendition.midi) return;

    stopEverything();
    var ticket = ++synth.request;
    /* 読み込み済みなら進捗の一段は出さない(0%が一瞬光るだけになるため) */
    var done = synth.status === "ready" ? function () {} : showLoading(rendition);
    function stale() { return synth.request !== ticket; }

    prepareSynth()
      .then(function () {
        if (stale()) return null;
        return synth.ctx.state === "suspended" ? synth.ctx.resume() : null;
      })
      .then(function () {
        if (stale()) return null;
        return fetch(assetUrl(work, rendition.midi), { cache: "force-cache" })
          .then(function (res) {
            if (!res.ok) throw new Error("HTTP " + res.status);
            return res.arrayBuffer();
          });
      })
      .then(function (buffer) {
        if (stale() || !buffer) return;
        done();
        synth.seq.loadNewSongList([{ binary: buffer, fileName: rendition.midi }]);
        synth.seq.loopCount = 0;
        synth.seq.play();
        state.playingId = rendition.id;
        state.mode = "synth";
        markPlaying(rendition.id);
        startSynthClock(rendition.id);
        el.status.hidden = true;
      })
      .catch(function () {
        if (stale()) return;
        done();
        clearPlaying();
        synthFailed("The built-in synthesizer could not start. The MP3 preview and the downloads still work.");
      });
  }

  /* --- 起動 -------------------------------------------------------------- */

  loadIndex()
    .then(function (data) {
      var tracks = Array.isArray(data.tracks) ? data.tracks : [];
      state.works = tracks.map(toWork).sort(function (a, b) {
        if (a.track.category !== b.track.category) {
          return a.track.category < b.track.category ? -1 : 1;
        }
        return a.track.seed - b.track.seed;
      });

      el.statTracks.textContent = state.works.length;
      el.footerEngine.textContent = data.engine_commit || "unknown";

      renderFilters();
      renderList();
      enrich();
    })
    .catch(function () {
      el.status.hidden = false;
      el.status.textContent =
        "The track list could not be loaded. Serve this page over HTTP — opening the file directly blocks the request.";
    });
})();
