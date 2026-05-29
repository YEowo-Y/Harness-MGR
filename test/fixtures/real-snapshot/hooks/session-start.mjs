// SYNTHETIC TEST FIXTURE - NOT REAL
// Never executed by the doctor passive run (only existence is checked by #3;
// #4 node --check is ACTIVE-only and the gate runs passive). Body is inert.
// (no executable body — doctor checks only this file's existence/syntax. A
// process.exit/throw here would be a false-green hazard if node --test ever
// collected this fixture .mjs, so the body is intentionally empty.)
export {};
