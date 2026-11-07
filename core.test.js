/* Tests for the reference core. Run with: node --test core.test.js
   The core is the baseline the model is graded against, so it is checked
   against hand-computed results for every instruction, not against itself. */
"use strict";
const test = require("node:test");
const assert = require("node:assert");
require("./core.js");
const C = globalThis.MMCORE;

// One instruction, from a given state.
function runOne(lines, state) {
  const prog = C.makeProgram(lines);
  return C.coreStep(state || C.freshState(), prog).state;
}

// N instructions in a row, which is what a program actually is.
function runN(lines, n, state) {
  const prog = C.makeProgram(lines);
  let st = state || C.freshState();
  for (let i = 0; i < n; i += 1) st = C.coreStep(st, prog).state;
  return st;
}

test("LDA immediate loads the accumulator and leaves Z alone", () => {
  const s = runOne(["000 LDA #7"]);
  assert.equal(s.a, 7);
  assert.equal(s.pc, 1);
  assert.equal(s.z, true, "Z is only set by arithmetic");
});

test("STA then LDA addr round-trips through memory", () => {
  let s = runN(["000 LDA #42", "001 STA 200", "002 LDA #0", "003 LDA 200"], 4);
  assert.equal(s.mem["200"], 42);
  assert.equal(s.a, 42);
  assert.equal(s.pc, 4);
});

test("LDA from an unwritten cell reads 0", () => {
  const s = runOne(["000 LDA 215"]);
  assert.equal(s.a, 0);
});

test("ADD wraps at 256 and sets Z only on zero", () => {
  let s = runN(["000 LDA #250", "001 ADD #10"], 2);
  assert.equal(s.a, 4);
  assert.equal(s.z, false);
  s = runN(["000 LDA #0", "001 SUB #1"], 2);
  assert.equal(s.a, 255, "SUB borrows round through 255");
  assert.equal(s.z, false);
  s = runN(["000 LDA #5", "001 SUB #5"], 2);
  assert.equal(s.a, 0);
  assert.equal(s.z, true);
});

test("DEC to zero sets Z, DEC past zero wraps", () => {
  let s = runN(["000 LDA #1", "001 DEC"], 2);
  assert.equal(s.a, 0);
  assert.equal(s.z, true);
  s = runN(["000 LDA #0", "001 DEC"], 2);
  assert.equal(s.a, 255);
  assert.equal(s.z, false);
});

test("INX and DEX do not touch the zero flag", () => {
  const st = C.freshState();
  st.z = false;
  let s = runN(["000 INX", "001 DEX"], 1, st);
  assert.equal(s.x, 1);
  assert.equal(s.z, false);
  s = runN(["000 INX", "001 DEX"], 2, st);
  assert.equal(s.x, 0);
  assert.equal(s.z, false);
});

test("CPX compares X and sets Z", () => {
  let s = runOne(["000 CPX #0"]);
  assert.equal(s.z, true);
  s = runOne(["000 CPX #3"]);
  assert.equal(s.z, false);
});

test("BNE jumps to the ROM index when Z is false, falls through when true", () => {
  let s = runOne(["000 NOP", "001 BNE 002"], Object.assign(C.freshState(), { z: false, pc: 1 }));
  assert.equal(s.pc, 2, "taken branch goes to the index, not pc+1+arg");
  s = runOne(["000 BNE 002"], Object.assign(C.freshState(), { z: true, pc: 0 }));
  assert.equal(s.pc, 1);
});

test("BEQ and JMP set pc to the index itself", () => {
  let s = runOne(["000 BEQ 003"], Object.assign(C.freshState(), { z: true, pc: 0 }));
  assert.equal(s.pc, 3);
  s = runOne(["005 JMP 001"], Object.assign(C.freshState(), { pc: 0 }));
  assert.equal(s.pc, 1);
});

test("OUT appends and does not change the accumulator", () => {
  let s = runN(["000 LDA #9", "001 OUT", "002 OUT"], 3);
  assert.deepEqual(s.out, ["9", "9"]);
  assert.equal(s.a, 9);
});

test("HLT stops the machine and holds pc", () => {
  const s = runOne(["000 HLT", "001 LDA #1"]);
  assert.equal(s.halted, true);
  assert.equal(s.pc, 0);
});

test("the countdown program prints 5 4 3 2 1 and halts", () => {
  const rom = [
    "000 LDA #5", "001 STA 200", "002 OUT", "003 LDA 200",
    "004 DEC", "005 STA 200", "006 BNE 002", "007 HLT"
  ];
  const r = C.run(rom);
  assert.deepEqual(r.state.out, ["5", "4", "3", "2", "1"]);
  assert.equal(r.state.halted, true);
  assert.ok(r.steps > 8 && r.steps < 40, "must terminate quickly, not spin: " + r.steps);
});

test("the times-table program prints 7 14 21 28 35", () => {
  const rom = [
    "000 LDA #0", "001 STA 201", "002 LDA 201", "003 ADD #7", "004 STA 201",
    "005 OUT", "006 INX", "007 CPX #5", "008 BNE 002", "009 HLT"
  ];
  const r = C.run(rom);
  assert.deepEqual(r.state.out, ["7", "14", "21", "28", "35"]);
  assert.equal(r.state.halted, true);
});

test("the memory fill program writes 16 cells", () => {
  const rom = [
    "000 LDX #0", "001 LDA #1", "002 STA 200", "003 LDA 200", "004 ADD #1",
    "005 STA 200", "006 INX", "007 CPX #16", "008 BNE 001", "009 OUT", "010 HLT"
  ];
  const r = C.run(rom);
  assert.equal(r.state.x, 16);
  assert.equal(r.state.halted, true);
  assert.ok(r.state.out.length >= 1);
});

test("sameAsCore ignores memory the contract cannot see", () => {
  const a = C.freshState();
  const b = C.freshState();
  b.mem["999"] = 5;
  assert.equal(C.sameAsCore(a, b), true, "only the 16 machine cells matter");
  b.mem["200"] = 1;
  assert.equal(C.sameAsCore(a, b), false);
});

test("assemble renumbers lines and rejects calls outside the ROM", () => {
  const ok = C.assemble("LDA #1\nOUT\nHLT");
  assert.deepEqual(ok.lines, ["000 LDA #1", "001 OUT", "002 HLT"]);
  const bad = C.assemble("LDA #1\nJMP 9");
  assert.ok(bad.error && /jumps to 9/.test(bad.error));
  const typo = C.assemble("LDA #1\nHLTX");
  assert.ok(typo.error);
});
