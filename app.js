/* Model Machine - an 8-bit computer whose CPU is a language model.
   The page holds the state. A Pollinations model performs each state transition.
   A reference core does the same transition in plain JavaScript, for comparison.
   No build step, no dependencies, no server. Visitors pay with their own Pollen. */
(function () {
  "use strict";

  var CFG = {
    clientId: "pk_DW7LrQVJgBaHP8Uo",
    authEndpoint: "https://enter.pollinations.ai/authorize",
    tokenEndpoint: "https://enter.pollinations.ai/api/oauth/token",
    userinfoEndpoint: "https://enter.pollinations.ai/api/oauth/userinfo",
    chatEndpoint: "https://gen.pollinations.ai/v1/chat/completions",
    scope: "profile usage",
    budget: 5,
    expiryDays: 7
  };

  var MODELS = [
    { id: "openai/gpt-5-nano", lab: "gpt-5-nano" },
    { id: "openai/gpt-oss-20b", lab: "gpt-oss-20b" },
    { id: "z-ai/glm-5.3-flash", lab: "glm-5.3-flash" },
    { id: "meta/llama-3.3-70b-instruct", lab: "llama-3.3-70b" },
    { id: "mistralai/mistral-large-3", lab: "mistral-large-3" },
    { id: "openai/gpt-5.4-nano", lab: "gpt-5.4-nano" },
    { id: "deepseek/deepseek-v4.1-flash", lab: "deepseek-v4.1-flash" }
  ];

  var ROMS = [
    {
      name: "count down and print",
      lines: [
        "000 LDA #5",
        "001 STA 200",
        "002 OUT",
        "003 LDA 200",
        "004 DEC",
        "005 STA 200",
        "006 BNE 002",
        "007 HLT"
      ]
    },
    {
      name: "times table of 7",
      lines: [
        "000 LDA #0",
        "001 STA 201",
        "002 LDA 201",
        "003 ADD #7",
        "004 STA 201",
        "005 OUT",
        "006 INX",
        "007 CPX #5",
        "008 BNE 002",
        "009 HLT"
      ]
    },
    {
      name: "fill memory 200-20F",
      lines: [
        "000 LDX #0",
        "001 LDA #1",
        "002 STA 200",
        "003 LDA 200",
        "004 ADD #1",
        "005 STA 200",
        "006 INX",
        "007 CPX #16",
        "008 BNE 001",
        "009 OUT",
        "010 HLT"
      ]
    },
    {
      name: "countdown that never ends",
      lines: [
        "000 LDA #3",
        "001 STA 200",
        "002 DEC",
        "003 JMP 002"
      ]
    }
  ];

  var SYSTEM_PROMPT = [
    "You are the CPU of MODEL MACHINE, a fictional 8-bit computer. You perform exactly ONE state transition: execute the instruction at pc and return the whole new machine state.",
    "",
    "The state is: pc (index into the ROM of the instruction to execute), a (8-bit accumulator, 0-255), x (8-bit index register, 0-255), z (the zero flag, a boolean), mem (object mapping a decimal address string to a byte, holding only cells that have been written), out (array of strings already printed), halted (boolean).",
    "",
    "Instructions, and their exact effect:",
    "LDA #n    a = n, then pc = pc + 1. The zero flag is unchanged.",
    "LDX #n    x = n, then pc = pc + 1. The zero flag is unchanged.",
    "LDA addr  a = mem[addr], or 0 when that cell has never been written. pc = pc + 1.",
    "STA addr  mem[addr] = a. pc = pc + 1. The accumulator is unchanged.",
    "ADD #n    a = (a + n) mod 256. z = (a == 0). pc = pc + 1.",
    "SUB #n    a = (a - n + 256) mod 256. z = (a == 0). pc = pc + 1.",
    "INC       a = (a + 1) mod 256. z = (a == 0). pc = pc + 1.",
    "DEC       a = (a - 1 + 256) mod 256. z = (a == 0). pc = pc + 1.",
    "INX       x = (x + 1) mod 256. pc = pc + 1. The zero flag is unchanged.",
    "DEX       x = (x - 1 + 256) mod 256. pc = pc + 1. The zero flag is unchanged.",
    "CPX #n    z = (x == n). pc = pc + 1. Nothing else changes.",
    "BEQ addr  if z is true, pc = addr, otherwise pc = pc + 1.",
    "BNE addr  if z is false, pc = addr, otherwise pc = pc + 1.",
    "JMP addr  pc = addr.",
    "OUT       append String(a) to out. pc = pc + 1. Nothing else changes.",
    "HLT       halted = true. pc stays on the HLT.",
    "",
    "Rules you must follow:",
    "1. addr in a jump or a load is a ROM index (the number at the start of the line), not pc+1, not a byte count.",
    "2. After a taken jump, pc is exactly that index.",
    "3. Never renumber the ROM, never reorder out, never drop a memory cell that was already written.",
    "4. If the machine is halted, HLT is not executable: return the state unchanged with note \"already halted\".",
    "",
    "Reply with ONE JSON object and no other text, with exactly these keys:",
    "{\"pc\":number,\"a\":number,\"x\":number,\"z\":boolean,\"mem\":{\"200\":number},\"out\":[\"string\"],\"halted\":boolean,\"note\":\"one short sentence naming the instruction and its effect\"}"
  ].join("\n");

  var $ = function (s) { return document.querySelector(s); };
  var tokenKey = "mm.token";
  var memBase = 200;
  var memSize = 16;
  var MAX_STEPS = 400;

  var S = {
    token: sessionStorage.getItem(tokenKey) || null,
    user: null,
    rom: ROMS[0].lines.slice(),
    romName: ROMS[0].name,
    machine: null,
    core: null,
    trace: [],
    agree: 0,
    steps: 0,
    tokens: 0,
    busy: false,
    halted: false,
    screenLines: [],
    selectedCell: null,
    model: MODELS[0].id,
    lastModel: "-"
  };

  /* ------------------------------------------------------------- machine core */

  function freshState() {
    var mem = {};
    for (var i = 0; i < memSize; i += 1) mem[String(memBase + i)] = 0;
    return { pc: 0, a: 0, x: 0, z: true, mem: mem, out: [], halted: false };
  }

  function clone(s) {
    var mem = {};
    Object.keys(s.mem).forEach(function (k) { mem[k] = s.mem[k]; });
    return { pc: s.pc, a: s.a, x: s.x, z: s.z, mem: mem, out: s.out.slice(), halted: s.halted };
  }

  // "000 LDA #5" -> { index: 0, op: "LDA", arg: 5, kind: "#" }
  function parseLine(line) {
    var text = String(line).replace(/;.*$/, "").trim();
    if (!text) return null;
    var m = text.match(/^(\d{1,3})?\s*([A-Za-z]{3})\b\s*([#]?)\s*(\d{1,3})?$/);
    if (!m) return null;
    var op = m[2].toUpperCase();
    var arg = m[4] === undefined ? null : parseInt(m[4], 10);
    return { index: m[1] === undefined ? null : parseInt(m[1], 10), op: op, kind: m[3], arg: arg };
  }

  function program() {
    var out = [];
    S.rom.forEach(function (line, i) {
      var p = parseLine(line);
      if (p) { p.index = i; out.push(p); }
    });
    return out;
  }

  // The reference core. Ordinary code, no model.
  function coreStep(state, prog) {
    var next = clone(state);
    var ins = prog[next.pc];
    if (!next.halted && !ins) {
      next.halted = true;
      return { state: next, note: "ran off the end of ROM" };
    }
    var op = ins.op, arg = ins.arg === null ? 0 : ins.arg;
    var wrapped = function (v) { return ((v % 256) + 256) % 256; };
    switch (op) {
      case "LDA":
        next.a = ins.kind === "#" ? wrapped(arg) : (next.mem[String(arg)] || 0);
        next.pc += 1; break;
      case "LDX":
        next.x = wrapped(arg); next.pc += 1; break;
      case "STA":
        next.mem[String(arg)] = next.a; next.pc += 1; break;
      case "ADD":
        next.a = wrapped(next.a + arg); next.z = next.a === 0; next.pc += 1; break;
      case "SUB":
        next.a = wrapped(next.a - arg); next.z = next.a === 0; next.pc += 1; break;
      case "INC":
        next.a = wrapped(next.a + 1); next.z = next.a === 0; next.pc += 1; break;
      case "DEC":
        next.a = wrapped(next.a - 1); next.z = next.a === 0; next.pc += 1; break;
      case "INX":
        next.x = wrapped(next.x + 1); next.pc += 1; break;
      case "DEX":
        next.x = wrapped(next.x - 1); next.pc += 1; break;
      case "CPX":
        next.z = next.x === wrapped(arg); next.pc += 1; break;
      case "BEQ":
        next.pc = next.z ? arg : next.pc + 1; break;
      case "BNE":
        next.pc = next.z ? next.pc + 1 : arg; break;
      case "JMP":
        next.pc = arg; break;
      case "OUT":
        next.out.push(String(next.a)); next.pc += 1; break;
      case "HLT":
        next.halted = true; break;
      default:
        next.halted = true;
        return { state: next, note: "unknown opcode " + op, error: true };
    }
    return { state: next, note: op.toLowerCase() + " executed" };
  }

  function sanitize(raw, prev) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("the reply was not a JSON object");
    var need = ["pc", "a", "x", "z", "mem", "out", "halted"];
    need.forEach(function (k) {
      if (!(k in raw)) throw new Error("the reply is missing the key " + k);
    });
    var byte = function (v, name) {
      var n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
      if (typeof n !== "number" || !isFinite(n)) throw new Error(name + " was not a number");
      n = Math.round(n);
      if (n < 0 || n > 255) throw new Error(name + " was " + n + ", outside 0-255");
      return n;
    };
    var pc = typeof raw.pc === "string" ? Number(raw.pc) : raw.pc;
    if (typeof pc !== "number" || !isFinite(pc)) throw new Error("pc was not a number");
    pc = Math.round(pc);
    if (pc < 0 || pc > S.rom.length) throw new Error("pc was " + pc + ", outside the ROM");
    if (typeof raw.z !== "boolean") throw new Error("z was not true or false");
    if (typeof raw.halted !== "boolean") throw new Error("halted was not true or false");
    if (!raw.mem || typeof raw.mem !== "object" || Array.isArray(raw.mem)) throw new Error("mem was not an object");
    if (!Array.isArray(raw.out)) throw new Error("out was not an array");

    var mem = {};
    for (var i = 0; i < memSize; i += 1) mem[String(memBase + i)] = 0;
    Object.keys(prev.mem).forEach(function (k) { mem[k] = prev.mem[k]; });
    Object.keys(raw.mem).forEach(function (k) {
      var addr = String(k).trim();
      if (!/^\d+$/.test(addr)) throw new Error("mem had a key that is not an address: " + k);
      mem[addr] = byte(raw.mem[k], "mem[" + addr + "]");
    });
    return {
      pc: pc,
      a: byte(raw.a, "a"),
      x: byte(raw.x, "x"),
      z: raw.z,
      mem: mem,
      out: raw.out.map(function (v) { return String(v); }),
      halted: raw.halted,
      note: typeof raw.note === "string" ? raw.note.slice(0, 160) : ""
    };
  }

  function sameAsCore(model, core) {
    if (model.pc !== core.pc) return false;
    if (model.a !== core.a) return false;
    if (model.x !== core.x) return false;
    if (model.z !== core.z) return false;
    if (model.halted !== core.halted) return false;
    if (model.out.length !== core.out.length) return false;
    for (var i = 0; i < core.out.length; i += 1) {
      if (model.out[i] !== core.out[i]) return false;
    }
    var keys = Object.keys(core.mem);
    for (var j = 0; j < keys.length; j += 1) {
      if ((model.mem[keys[j]] || 0) !== (core.mem[keys[j]] || 0)) return false;
    }
    return true;
  }

  /* ------------------------------------------------------------------- auth */

  function pageUrl() {
    var path = window.location.pathname.replace(/index\.html$/, "");
    return window.location.origin + path;
  }
  function b64url(buf) {
    var bytes = new Uint8Array(buf);
    var s = "";
    for (var i = 0; i < bytes.length; i += 1) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function rnd(n) {
    var alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
    var b = new Uint8Array(n);
    crypto.getRandomValues(b);
    var out = "";
    for (var i = 0; i < n; i += 1) out += alphabet[b[i] % alphabet.length];
    return out;
  }
  function signIn() {
    var verifier = rnd(64);
    var stateParam = rnd(24);
    sessionStorage.setItem("mm.verifier", verifier);
    sessionStorage.setItem("mm.state", stateParam);
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)).then(b64url).then(function (ch) {
      var params = new URLSearchParams({
        response_type: "code",
        client_id: CFG.clientId,
        redirect_uri: pageUrl(),
        scope: CFG.scope,
        budget: String(CFG.budget),
        models: "text",
        expiry: String(CFG.expiryDays),
        state: stateParam,
        code_challenge: ch,
        code_challenge_method: "S256"
      });
      window.location.assign(CFG.authEndpoint + "?" + params.toString());
    });
  }
  function finishSignIn() {
    var params = new URLSearchParams(window.location.search);
    var code = params.get("code");
    var err = params.get("error");
    if (!code && !err) return Promise.resolve(false);
    if (window.history && window.history.replaceState) window.history.replaceState(null, "", pageUrl());
    if (err) {
      setStatus("Sign in failed: " + err + " " + (params.get("error_description") || ""), true);
      return Promise.resolve(true);
    }
    var verifier = sessionStorage.getItem("mm.verifier");
    if (!verifier) {
      setStatus("Sign in could not finish: this tab lost its PKCE verifier. Sign in again.", true);
      return Promise.resolve(true);
    }
    setStatus("Finishing sign in...", false);
    return fetch(CFG.tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: code,
        client_id: CFG.clientId,
        redirect_uri: pageUrl(),
        code_verifier: verifier
      })
    }).then(function (r) {
      return r.json().then(function (data) {
        if (!r.ok || !data.access_token) {
          throw new Error((data && (data.error_description || data.error)) || ("HTTP " + r.status));
        }
        S.token = data.access_token;
        sessionStorage.setItem(tokenKey, data.access_token);
        sessionStorage.removeItem("mm.verifier");
        return loadUser();
      });
    }).then(function () {
      setStatus("Signed in. Your own Pollen pays for every instruction.", false);
      return true;
    }).catch(function (e) {
      setStatus("Sign in failed: " + (e && e.message ? e.message : "unknown error"), true);
      return true;
    });
  }
  function loadUser() {
    if (!S.token) {
      $("#who").textContent = "Not signed in";
      $("#signBtn").textContent = "Sign in with Pollen";
      return Promise.resolve();
    }
    return fetch(CFG.userinfoEndpoint, { headers: { Authorization: "Bearer " + S.token } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; })
      .then(function (u) {
        S.user = u;
        var name = (u && (u.name || u.email || u.githubUsername || u.username)) || "Pollen account";
        $("#who").textContent = name;
        $("#signBtn").textContent = "Sign out";
      });
  }

  /* ---------------------------------------------------------------- model call */

  function stripJson(text) {
    var t = String(text || "").trim();
    var fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) t = fence[1].trim();
    var start = t.indexOf("{");
    var end = t.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) throw new Error("the reply had no JSON object in it");
    return t.slice(start, end + 1);
  }

  function askMachine(machine) {
    var prog = program();
    var listing = S.rom.map(function (line, i) {
      return String(i).padStart(3, "0") + "  " + String(line).replace(/^\s*\d{1,3}\s*/, "");
    }).join("\n");
    var payload = {
      state: {
        pc: machine.pc, a: machine.a, x: machine.x, z: machine.z,
        mem: writtenCells(machine), out: machine.out, halted: machine.halted
      },
      rom: listing,
      execute: machine.halted ? "HLT" : (prog[machine.pc] ? PROG_TEXT(prog[machine.pc]) : "past the end of ROM")
    };
    var body = {
      model: S.model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: "Machine state and ROM:\n" + JSON.stringify(payload, null, 1) + "\n\nReturn the new state after this one instruction." }
      ],
      max_tokens: 900,
      reasoning_effort: "low"
    };
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, 90000);
    var t0 = performance.now();
    return fetch(CFG.chatEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + S.token },
      body: JSON.stringify(body),
      signal: ctrl.signal
    }).then(function (r) {
      return r.text().then(function (raw) {
        clearTimeout(timer);
        var data = null;
        try { data = JSON.parse(raw); } catch (e) { data = null; }
        if (!r.ok) {
          var msg = (data && data.error && (data.error.message || data.error)) || raw || ("HTTP " + r.status);
          var err = new Error(String(typeof msg === "string" ? msg : JSON.stringify(msg)).slice(0, 180));
          err.status = r.status;
          throw err;
        }
        var ch = data && data.choices && data.choices[0];
        var content = ch && ch.message ? (ch.message.content || "") : "";
        if (Array.isArray(content)) {
          content = content.map(function (p) { return typeof p === "string" ? p : (p && p.text) || ""; }).join(" ");
        }
        return {
          text: String(content || ""),
          tokens: (data.usage && data.usage.total_tokens) || 0,
          ms: performance.now() - t0
        };
      });
    }).catch(function (e) {
      clearTimeout(timer);
      if (e && e.name === "AbortError") {
        var t = new Error("no answer within 90s");
        t.status = 0;
        throw t;
      }
      if (e && !e.status) e.status = -1;
      throw e;
    });
  }

  function PROG_TEXT(p) {
    if (!p) return "";
    return p.op + (p.arg === null ? "" : (p.kind === "#" ? " #" : " ") + p.arg);
  }

  function writtenCells(machine) {
    var out = {};
    Object.keys(machine.mem).forEach(function (k) {
      if (machine.mem[k]) out[k] = machine.mem[k];
    });
    return out;
  }

  /* ------------------------------------------------------------------- step */

  function step() {
    if (S.busy) return Promise.resolve(false);
    if (!S.token) {
      setStatus("Sign in with Pollinations first, so your own Pollen pays for the instructions.", true);
      return Promise.resolve(false);
    }
    if (S.steps >= MAX_STEPS) {
      setStatus("Step limit reached. Reset to run again.", true);
      return Promise.resolve(false);
    }
    var prog = program();
    var before = S.machine;
    S.busy = true;
    updateButtons();
    setStatus("The model is executing " + (before.halted ? "HLT" : PROG_TEXT(prog[before.pc]) || "the next instruction") + "...", false);

    var coreResult = before.halted ? { state: clone(before), note: "already halted" } : coreStep(before, prog);

    return askMachine(before).then(function (res) {
      S.tokens += res.tokens;
      S.lastModel = S.model;
      var next = sanitize(JSON.parse(stripJson(res.text)), before);
      var match = sameAsCore(next, coreResult.state);
      S.agree += match ? 1 : 0;
      S.steps += 1;
      S.machine = next;
      S.core = coreResult.state;

      S.trace.unshift({
        n: S.steps,
        op: before.halted ? "HLT" : PROG_TEXT(prog[before.pc]),
        note: next.note || "(no note)",
        drift: !match,
        spent: res.tokens
      });
      if (next.out.length > before.out.length) {
        next.out.slice(before.out.length).forEach(function (v) {
          S.screenLines.push(v);
          if (S.screenLines.length > 24) S.screenLines.shift();
        });
      }
      if (next.halted && !before.halted) setStatus("HLT reached. The machine stopped itself in " + S.steps + " steps.", false);
      else if (match) setStatus("", false);
      else setStatus("The model's state differs from the reference core on this step. The machine follows the model.", true);
      render();
      return true;
    }).catch(function (e) {
      S.trace.unshift({
        n: S.steps + 1,
        op: before.halted ? "HLT" : PROG_TEXT(prog[before.pc]),
        note: "step failed: " + (e && e.message ? e.message : "unknown error"),
        err: true
      });
      setStatus("The model did not return a usable state: " + (e && e.message ? e.message : "unknown error"), true);
      render();
      return false;
    }).then(function (ok) {
      S.busy = false;
      updateButtons();
      return ok;
    });
  }

  function runN(n) {
    var i = 0;
    var tick = function () {
      if (i >= n || S.halted) return Promise.resolve();
      i += 1;
      return step().then(function (ok) {
        if (!ok) return;
        return new Promise(function (r) { setTimeout(r, 120); }).then(tick);
      });
    };
    return tick();
  }

  function resetMachine(keepScreen) {
    S.machine = freshState();
    S.core = freshState();
    S.trace = [];
    S.agree = 0;
    S.steps = 0;
    if (!keepScreen) S.screenLines = [];
    S.halted = false;
    setStatus("", false);
    render();
  }

  /* ------------------------------------------------------------------ render */

  function setStatus(msg, isErr) {
    var node = $("#status");
    node.textContent = msg || "";
    node.className = "status" + (isErr ? " err" : "");
  }

  function updateButtons() {
    var stalled = !S.machine || S.machine.halted;
    $("#stepBtn").disabled = S.busy || stalled;
    $("#runBtn").disabled = S.busy || stalled;
    $("#stepBtn").textContent = S.busy ? "Running..." : "Step";
  }

  function renderScreen() {
    var lines = S.screenLines.slice();
    var node = $("#screen");
    node.textContent = "";
    if (!lines.length) {
      var i1 = document.createElement("span");
      i1.className = "idle";
      i1.textContent = "MODEL MACHINE 1.0\nno output yet\n";
      node.appendChild(i1);
    } else {
      lines.forEach(function (l) {
        var d = document.createElement("div");
        d.textContent = l;
        node.appendChild(d);
      });
    }
    var c = document.createElement("span");
    c.className = "cursor";
    c.textContent = " ";
    node.appendChild(c);
    node.scrollTop = node.scrollHeight;
  }

  function renderRegs() {
    var m = S.machine;
    $("#rPC").querySelector(".v").textContent = m.pc;
    var a = $("#rA").querySelector(".v");
    a.textContent = m.a;
    var as = document.createElement("small");
    as.textContent = pad2hex(m.a);
    a.appendChild(as);
    var x = $("#rX").querySelector(".v");
    x.textContent = m.x;
    var xs = document.createElement("small");
    xs.textContent = pad2hex(m.x);
    x.appendChild(xs);
    $("#rZ").querySelector(".v").textContent = m.z ? "1" : "0";
  }
  function pad2hex(v) {
    var h = Number(v).toString(16).toUpperCase();
    return h.length < 2 ? "0" + h : h;
  }

  function renderMem() {
    var box = $("#mem");
    box.textContent = "";
    for (var i = 0; i < memSize; i += 1) {
      var addr = memBase + i;
      var val = S.machine.mem[String(addr)] || 0;
      var cell = document.createElement("div");
      cell.className = "cell" + (val ? " written" : "") + (S.selectedCell === addr ? " sel" : "");
      var ad = document.createElement("span");
      ad.className = "ad";
      ad.textContent = String(addr).slice(-2);
      var by = document.createElement("span");
      by.className = "by";
      by.textContent = val;
      cell.appendChild(ad);
      cell.appendChild(by);
      (function (a) {
        cell.addEventListener("click", function () {
          S.selectedCell = a;
          pokeCell(a);
        });
      })(addr);
      box.appendChild(cell);
    }
  }

  function pokeCell(addr) {
    var cur = S.machine.mem[String(addr)] || 0;
    var raw = window.prompt("Write a byte to memory cell " + addr + " (0-255). The machine state is yours; the model only executes instructions.", String(cur));
    if (raw === null) return;
    var n = parseInt(raw, 10);
    if (isNaN(n) || n < 0 || n > 255) { setStatus("A byte is a whole number from 0 to 255.", true); return; }
    S.machine.mem[String(addr)] = n;
    if (S.core) S.core.mem[String(addr)] = n;
    setStatus("Wrote " + n + " to cell " + addr + ". The next step starts from there.", false);
    render();
  }

  function renderListing() {
    var prog = program();
    var node = $("#listing");
    node.textContent = "";
    S.rom.forEach(function (line, i) {
      var span = document.createElement("div");
      var text = String(line);
      span.textContent = text;
      if (S.machine && i === S.machine.pc && !S.machine.halted) span.className = "pc";
      else if (S.machine && i < S.machine.pc && !S.machine.halted) span.className = "done";
      node.appendChild(span);
    });
    if (!prog.length) {
      var e = document.createElement("div");
      e.className = "empty";
      e.textContent = "The ROM is empty.";
      node.appendChild(e);
    }
  }

  function renderTrace() {
    var box = $("#trace");
    box.textContent = "";
    if (!S.trace.length) {
      var e = document.createElement("div");
      e.className = "empty";
      e.textContent = "Press Step. Each step is one model call, and the model is doing the arithmetic.";
      box.appendChild(e);
    }
    S.trace.slice(0, 60).forEach(function (t) {
      var row = document.createElement("div");
      row.className = "row" + (t.err ? " err" : "") + (!t.err && t.drift ? " drift" : "");
      var ix = document.createElement("div");
      ix.className = "ix";
      ix.textContent = "#" + t.n;
      var body = document.createElement("div");
      var op = document.createElement("div");
      op.className = "op";
      op.textContent = t.op;
      var note = document.createElement("div");
      note.className = "note";
      note.textContent = (t.err ? "" : (t.drift ? "drift: " : "") ) + t.note;
      body.appendChild(op);
      body.appendChild(note);
      row.appendChild(ix);
      row.appendChild(body);
      box.appendChild(row);
    });
    $("#traceCount").textContent = S.steps + " retired";
  }

  function renderFid() {
    var pct = S.steps ? Math.round((S.agree / S.steps) * 100) : 0;
    $("#fidFill").style.width = pct + "%";
    $("#fidFill").style.background = pct >= 90 ? "var(--phosphor)" : pct >= 60 ? "var(--amber)" : "var(--alarm)";
    $("#fidNum").textContent = S.steps ? S.agree + "/" + S.steps + " match (" + pct + "%)" : "no steps yet";
  }

  function renderVitals() {
    $("#clock").textContent = S.steps;
    $("#modelUsed").textContent = S.lastModel;
    $("#cost").textContent = S.tokens + " tok";
    var m = S.machine;
    $("#powerState").textContent = m.halted ? "halted" : "running";
    var core = $("#coreState");
    if (!S.steps) { core.textContent = "core idle"; core.className = "ok"; }
    else {
      var same = sameAsCore(m, S.core);
      core.textContent = same ? "core agrees" : "core disagrees";
      core.className = same ? "ok" : "bad";
    }
  }

  function render() {
    if (!S.machine) resetMachine();
    renderScreen();
    renderRegs();
    renderMem();
    renderListing();
    renderTrace();
    renderFid();
    renderVitals();
    updateButtons();
    S.halted = S.machine.halted;
  }

  /* ------------------------------------------------------------------ wiring */

  function buildModels() {
    var sel = $("#modelSel");
    sel.textContent = "";
    MODELS.forEach(function (m) {
      var o = document.createElement("option");
      o.value = m.id;
      o.textContent = m.lab;
      sel.appendChild(o);
    });
    sel.value = S.model;
  }

  function buildRoms() {
    var sel = $("#romSel");
    sel.textContent = "";
    ROMS.forEach(function (r) {
      var o = document.createElement("option");
      o.value = r.name;
      o.textContent = r.name;
      sel.appendChild(o);
    });
    sel.value = S.romName;
  }

  function assemble(text) {
    var lines = String(text).split("\n").map(function (l) { return l.trim(); }).filter(function (l) { return l.length; });
    if (!lines.length) return { error: "Nothing to assemble: the ROM would be empty." };
    var ops = ["LDA", "LDX", "STA", "ADD", "SUB", "INC", "DEC", "INX", "DEX", "CPX", "BEQ", "BNE", "JMP", "OUT", "HLT"];
    for (var i = 0; i < lines.length; i += 1) {
      var p = parseLine(lines[i]);
      if (!p) return { error: "Line " + (i + 1) + " is not an instruction in this opcode set." };
      if (ops.indexOf(p.op) === -1) return { error: "Unknown opcode " + p.op + " on line " + (i + 1) + "." };
      var needsArg = ["LDA", "LDX", "STA", "ADD", "SUB", "CPX", "BEQ", "BNE", "JMP"].indexOf(p.op) !== -1;
      if (needsArg && p.arg === null) return { error: p.op + " on line " + (i + 1) + " needs a number." };
      if (needsArg && ["BEQ", "BNE", "JMP"].indexOf(p.op) !== -1 && p.arg >= lines.length) {
        return { error: p.op + " on line " + (i + 1) + " jumps to " + p.arg + ", but the ROM ends at " + (lines.length - 1) + "." };
      }
      lines[i] = String(i).padStart(3, "0") + " " + PROG_TEXT(p);
    }
    return { lines: lines };
  }

  document.addEventListener("DOMContentLoaded", function () {
    buildModels();
    buildRoms();
    resetMachine();

    $("#signBtn").addEventListener("click", function () {
      if (S.token) {
        sessionStorage.removeItem(tokenKey);
        S.token = null;
        S.user = null;
        loadUser();
        setStatus("Signed out. The key was removed from this tab.", false);
        return;
      }
      signIn();
    });

    $("#stepBtn").addEventListener("click", function () { step(); });
    $("#runBtn").addEventListener("click", function () { runN(8); });
    $("#resetBtn").addEventListener("click", function () { resetMachine(true); });

    $("#modelSel").addEventListener("change", function () {
      S.model = this.value;
      setStatus("CPU is now " + this.options[this.selectedIndex].textContent + ". Reset to start a clean run.", false);
    });

    $("#romSel").addEventListener("change", function () {
      var found = ROMS.filter(function (r) { return r.name === this.value; }, this)[0];
      if (!found) return;
      S.romName = found.name;
      S.rom = found.lines.slice();
      resetMachine();
      setStatus("Loaded ROM: " + found.name + ". Reset done.", false);
    });

    $("#editBtn").addEventListener("click", function () {
      var wrap = $("#romEditWrap");
      var open = wrap.style.display !== "none";
      wrap.style.display = open ? "none" : "block";
      if (!open) {
        $("#romEdit").value = S.rom.map(function (l, i) {
          return String(i).padStart(3, "0") + " " + String(l).replace(/^\s*\d{1,3}\s*/, "");
        }).join("\n");
        $("#romEdit").focus();
      }
    });

    $("#applyRom").addEventListener("click", function () {
      var res = assemble($("#romEdit").value);
      if (res.error) { setStatus(res.error, true); return; }
      S.rom = res.lines;
      S.romName = "custom program";
      S.rom = res.lines;
      resetMachine();
      $("#romEditWrap").style.display = "none";
      setStatus("Assembled " + res.lines.length + " instructions. Reset done.", false);
    });

    $("#cancelRom").addEventListener("click", function () {
      $("#romEditWrap").style.display = "none";
    });

    render();
    finishSignIn().then(loadUser);
  });
})();
