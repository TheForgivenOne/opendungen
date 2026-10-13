// Example script (documentation only — never seeded). It demonstrates
// the entire sandbox surface a script may use: `state` for memory
// across turns, `text` as the writable input/output value, and `log`
// for server-side debug notes. `context` and `history` are also
// available depending on the hook; fetch, timers, and Date are not.
//
// What it does: when the player's input contains the word SHOUT, the
// whole input is uppercased and a counter in state tracks how many
// times the filter has fired.

export const EXAMPLE_SCRIPT = `if (typeof text === "string" && text.includes("SHOUT")) {
  state.shouts = (state.shouts || 0) + 1;
  log("echo filter fired " + state.shouts + " time(s)");
  text = text.toUpperCase();
}
`;
