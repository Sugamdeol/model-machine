/* The reference core for Model Machine.
   A plain, exact implementation of the machine's instruction set. It is the
   baseline the model's output is compared against, so it lives in its own file
   and is tested on its own (see core.test.js). No DOM, no network. */
(function (root) {
  "use strict";

  var MEM_BASE = 200;
  var MEM_SIZE = 16;
  var OPS = ["LDA", "LDX", "STA", "ADD", "SUB", "INC", "DEC", "INX", "DEX", "CPX", "BEQ", "BNE", "JMP", "OUT", "HLT"];
  var NEEDS_ARG = ["LDA", "LDX", "STA", "ADD", "SUB", "CPX", "BEQ", "BNE", "JMP"];

  function freshState() {
    var mem = {};
    for (var i = 0; i < MEM_SIZE; i += 1) mem[String(MEM_BASE + i)] = 0;
    return { pc: 0, a: 0, x: 0, z: true, mem: mem, out: [], halted: false };
  }

  function clone(s) {
    var mem = {};
    Object.keys(s.mem).forEach(function (k) { mem[k] = s.mem[k]; });
    return { pc: s.pc, a: s.a, x: s.x, z: s.z, mem: mem, out: s.out.slice(), halted: s.halted };
  }

  // "003 BNE 002" -> { index: 3, op: "BNE", kind: "", arg: 2 }
  function parseLine(line) {
    var text = String(line).replace(/;.*$/, "").trim();
    if (!text) return null;
    var m = text.match(/^(\d{1,3})?\s*([A-Za-z]{3})\b\s*(#?)\s*(\d{1,3})?$/);
    if (!m) return null;
    return {
      index: m[1] === undefined ? null : parseInt(m[1], 10),
      op: m[2].toUpperCase(),
      kind: m[3],
      arg: m[4] === undefined ? null : parseInt(m[4], 10)
    };
  }

  // Sparse array parallel to the ROM lines, so a pc is always a line index.
  function makeProgram(lines) {
    var prog = [];
    for (var i = 0; i < lines.length; i += 1) prog.push(parseLine(lines[i]));
    return prog;
  }

  function text(p) {
    if (!p) return "";
    return p.op + (p.arg === null ? "" : (p.kind === "#" ? " #" : " ") + p.arg);
  }

  function wrap(v) { return ((v % 256) + 256) % 256; }

  function coreStep(state, prog) {
    var next = clone(state);
    if (next.halted) return { state: next, note: "already halted" };
    var ins = prog[next.pc];
    if (!ins) return { state: next, note: "ran off the end of ROM", error: true };
    var op = ins.op;
    var arg = ins.arg === null ? 0 : ins.arg;
    switch (op) {
      case "LDA":
        next.a = ins.kind === "#" ? wrap(arg) : (next.mem[String(arg)] || 0);
        next.pc += 1; break;
      case "LDX":
        next.x = wrap(arg); next.pc += 1; break;
      case "STA":
        next.mem[String(arg)] = next.a; next.pc += 1; break;
      case "ADD":
        next.a = wrap(next.a + arg); next.z = next.a === 0; next.pc += 1; break;
      case "SUB":
        next.a = wrap(next.a - arg); next.z = next.a === 0; next.pc += 1; break;
      case "INC":
        next.a = wrap(next.a + 1); next.z = next.a === 0; next.pc += 1; break;
      case "DEC":
        next.a = wrap(next.a - 1); next.z = next.a === 0; next.pc += 1; break;
      case "INX":
        next.x = wrap(next.x + 1); next.pc += 1; break;
      case "DEX":
        next.x = wrap(next.x - 1); next.pc += 1; break;
      case "CPX":
        next.z = next.x === wrap(arg); next.pc += 1; break;
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
        return { state: next, note: "unknown opcode " + op, error: true };
    }
    if (next.pc > prog.length) return { state: next, note: op + " moved pc outside the ROM", error: true };
    return { state: next, note: op.toLowerCase() + " executed" };
  }

  // Compare only what the machine means: registers, flags, output, written memory.
  function sameAsCore(model, core) {
    if (model.pc !== core.pc || model.a !== core.a || model.x !== core.x) return false;
    if (model.z !== core.z || model.halted !== core.halted) return false;
    if (model.out.length !== core.out.length) return false;
    for (var i = 0; i < core.out.length; i += 1) if (model.out[i] !== core.out[i]) return false;
    // Only the sixteen machine cells exist. A model that invents an address
    // outside them has not changed the machine, so it is not counted as drift.
    for (var j = 0; j < MEM_SIZE; j += 1) {
      var k = String(MEM_BASE + j);
      if ((model.mem[k] || 0) !== (core.mem[k] || 0)) return false;
    }
    return true;
  }

  function assemble(source) {
    var lines = String(source).split("\n").map(function (l) { return l.trim(); })
      .filter(function (l) { return l.length && l.charAt(0) !== ";"; });
    if (!lines.length) return { error: "Nothing to assemble: the ROM would be empty." };
    for (var i = 0; i < lines.length; i += 1) {
      var p = parseLine(lines[i]);
      if (!p) return { error: "Line " + (i + 1) + " is not an instruction in this opcode set." };
      if (OPS.indexOf(p.op) === -1) return { error: "Unknown opcode " + p.op + " on line " + (i + 1) + "." };
      if (NEEDS_ARG.indexOf(p.op) !== -1 && p.arg === null) {
        return { error: p.op + " on line " + (i + 1) + " needs a number." };
      }
      if (["BEQ", "BNE", "JMP"].indexOf(p.op) !== -1 && p.arg >= lines.length) {
        return { error: p.op + " on line " + (i + 1) + " jumps to " + p.arg + ", but the ROM ends at line " + (lines.length - 1) + "." };
      }
      lines[i] = pad3(i) + " " + text(p);
    }
    return { lines: lines };
  }

  function pad3(n) {
    var s = String(n);
    while (s.length < 3) s = "0" + s;
    return s;
  }

  // Run a whole program on the core alone. Used by the tests and by the page to
  // show what the machine would have printed if it had a real CPU.
  function run(lines, maxSteps) {
    var prog = makeProgram(lines);
    var st = freshState();
    var steps = 0;
    var cap = maxSteps || 400;
    while (!st.halted && steps < cap) {
      st = coreStep(st, prog).state;
      steps += 1;
    }
    return { state: st, steps: steps };
  }

  root.MMCORE = {
    MEM_BASE: MEM_BASE,
    MEM_SIZE: MEM_SIZE,
    OPS: OPS,
    freshState: freshState,
    clone: clone,
    parseLine: parseLine,
    makeProgram: makeProgram,
    coreStep: coreStep,
    sameAsCore: sameAsCore,
    assemble: assemble,
    run: run,
    text: text
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
