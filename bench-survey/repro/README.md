# Non-compiling repros

    SCRIPTC=../../../../scriptc/packages/cli/dist/main.js
    for f in fill flat toUpperCase; do
      # reuse ../profile.json but point entry at repro/$f.ts, or:
      SCRIPTC_CC=zigcc SCRIPTC_TARGET=wasm32-wasi node $SCRIPTC coverage $f.ts   # fill/flat: SC2020
    done

fill/flat: SC2020 at typecheck. toUpperCase: passes coverage, fails wasm link
(scr_str_to_upper missing) — a wasm runtime gap, not a language limit.
