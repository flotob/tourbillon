/*
xen.mjs - <short description TODO>
Copyright (C) 2022 Strudel contributors - see <https://codeberg.org/uzu/strudel/src/branch/main/packages/xen/xen.mjs>
This program is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import { register, _mod, parseNumeral, removeUndefineds, Pattern, parray, reify, State, flatten } from '@strudel/core';
import Tune from './tunejs.js';

// returns a list of frequency ratios for given edo scale
export function edo(name) {
  if (!/^[1-9]+[0-9]*edo$/.test(name)) {
    throw new Error('not an edo scale: "' + name + '"');
  }
  const [_, divisions] = name.match(/^([1-9]+[0-9]*)edo$/);
  return Array.from({ length: divisions }, (_, i) => Math.pow(2, i / divisions));
}

const presets = {
  '12ji': [1 / 1, 16 / 15, 9 / 8, 6 / 5, 5 / 4, 4 / 3, 45 / 32, 3 / 2, 8 / 5, 5 / 3, 16 / 9, 15 / 8],
};

// Given a base frequency such as 220 and an edo scale, returns
// an array of frequencies representing the given edo scale in that base
function _withBase(freq, scale) {
  return scale.map((r) => r * freq);
}

const defaultBase = 220;

const isEdo = (scale) => /^[1-9]+[0-9]*edo$/.test(scale);

// Assumes a base of 220. Returns a filtered scale based on 'indices'
// NOTE: indices functionality is unused
function getXenScale(scale, indices) {
  let tune = new Tune();
  if (typeof scale === 'string') {
    if (isEdo(scale)) {
      scale = edo(scale);
    } else if (presets[scale]) {
      scale = presets[scale];
    } else if (tune.isValidScale(scale)) {
      tune.loadScale(scale);
      scale = tune.scale;
    } else {
      throw new Error('unknown scale name: "' + scale + '"');
    }
  }
  scale = _withBase(defaultBase, scale);
  if (!indices) {
    return scale;
  }
  return scale.filter((_, i) => indices.includes(i));
}

function xenOffset(xenScale, offset, index = 0) {
  const i = _mod(index + offset, xenScale.length);
  const oct = Math.floor(offset / xenScale.length);
  return xenScale[i] * Math.pow(2, oct);
}

const trimFreq = (freq) => parseFloat(freq.toPrecision(10));

// accepts a scale name such as 31edo, and a pattern
// pattern expected to follow format such that a value can be mapped
// to an edostep within the scale. Returns the pattern with
// values mapped to the frequencies associated with the given edosteps
// scaleNameOrRatios: string || number[], steps?: number

/**
 * Assumes a numerical pattern of scale steps, and a scale. Scales accepted are all preset scale names of `tune`, arbitrary edos such as 31edo, or an array of frequency ratios. Assumes scales repeat at octave (2/1). Returns a new pattern with all values mapped to their associated frequency, assuming a base frequency of 220hz.
 *
 * @name xen
 * @returns Pattern
 * @memberof Pattern
 * @param {(string | number[] )} scaleNameOrRatios
 * @tags tonal
 * @example
 * // A minor triad in 31edo:
 * i("0 8 18").xen("31edo").piano()
 * @example
 * // You can also use xen with frequency ratios.
 * // This is equivalent to the above:
 * i("0 1 2").xen([
 *   Math.pow(2, 0/31),
 *   Math.pow(2, 8/31),
 *   Math.pow(2, 18/31),
 * ]).piano()
 * @example
 * // xen also supports all scale names that
 * // tune does:
 * i("0 1 2 3 4 5").xen("hexany15")
 * // equiv to:
 * // "0 1 2 3 4 5".tune("hexany15").mul("220").freq()
 * @example
 * i("0 1 2 3 4 5 6 7").xen("<5edo 10edo 15edo hexany15>")
 */

export const xen = register(
  'xen',
  function (scaleNameOrRatios, pat) {
    const JIsc3 = (input) => {
      let k = input;

      return new Pattern((state) => {
        let res = k.query(state);
        res = parray(
          k.query(state).map((x) => {
            let c = x.context;
            x = eval(x.value.join('/'));
            let r = reify(x).setContext(c);
            return r;
          }),
        ).query(state);
        return res;
      });
    };

    // How do we use curry to solve the stack problem
    /* 
  Register does this by effectively saying
  are there multiple args?
  If so, split them into two arrays
  left has 1, right has rest
  join left and right:
    
    result = join(right.reduce((acc, p) => acc.appLeft(p), left.fmap(mapFn))); 
  
  where mapFn applies the registered function 'func'.
  ----
  When we're in xen but not in query, then we already have access to `scaleNameOrRatios`
  Could we run query for each? (could that be 'func' in this case?) 
  ----
  I don't think so, I think it makes more sense to do it within the query, but call an innerfunc on each arg
  ----
  Okay, working for strings.

  How do you tell the different between these two inputs?

  i("0 1").xen(`
    1:1,
    [13:12, 5:4],
    2:1
  `).piano().log()

  i("0 1").xen(`
    1:1,
    13:12, 
    5:4,
    2:1
  `).piano().log()


  If it's not, we can just do: 
  xen([
    "1:1",
    "[13:12, 5:4]",
    ...
  ])

  ---- 
  
  okay I got the above working and now I need to rejigger this one to work with the other stuff
  
  i("0 1 2 3").xen("hexany15, [sev-elev hexany23]").s("sin")

  */

    const JIsc2 = (input) => {
      let k = parray(input)

      return new Pattern((state) => {
        let res = k.withValue(x => x.map(y => eval(y.join('/')))).query(state)
        return res
      })
    }

    const query = (state) => {
      let input = scaleNameOrRatios.query(state);
      
      let scPat = input[0].value
      let scs
      if (typeof scPat == 'string') {
        scs = [scPat]
      } else {
        scs = JIsc2(scPat).query(state)
      }

      let k = scs.map(sc => {
        let haps = pat
          .withHap((hap) => {
            let hVal = hap.value;
            const isObject = typeof hVal === 'object';
            if (!isObject) {
              throw new Error(
                `Expected hap to have control 'i' set, but received ${hap.value.i}, try wrapping input in i()`,
              );
            }
            const { i, ...otherValues } = hVal;
            let scale;
            let edo = false;
            let st = new State(state.span.intersection(hap.part));
            if (typeof sc == 'string') {
              scale = getXenScale(sc);
              if (isEdo(sc)) {
                edo = sc.match(/^([1-9]+[0-9]*)edo$/)[1];
              }
              hap = hap.setContext(hap.combineContext(sc));
            } else {
              scale = getXenScale(sc.value);
              for (let h of scPat[i].query(state)) {
                hap = hap.setContext(hap.combineContext(h));
              }
            }
            let freq = xenOffset(scale, parseNumeral(hVal.i));
            // 10 is somewhat arbitrary
            freq = trimFreq(freq);
            hap.value = { ...otherValues, freq };
            return edo ? hap.setContext({ ...hap.context, edoSize: edo }) : hap;
          })
          .query(state);
        // return removeUndefineds(haps);
        return haps
      })
      return flatten(k)
    };

    /* 
  perhaps instead of 
    return new Pattern(query)
  we could do a join on scaleNameOrRatios which creates multiple patterns and then joins them
  */
    return new Pattern(query);
  },
  false,
);

/**
 * Assumes pattern of frequencies tuned to some `base` frequency, such as the output of `xen`
 * Because `xen` defaults to `220Hz`, so will `withBase`.
 * but you can specify a different original base with the standard optional array syntax '`:`'
 * @name withBase
 * @param {number} base
 * @param {number} (optional) originalBase
 * @tags tonal
 *
 * @example
 * i("[0 1 2 3] [3 4] [4 3 2 1]").xen("hexany23").withBase("<220 [300 200]>")
 * @example
 * mini([1 / 1, 16 / 15, 9 / 8, 6 / 5, 5 / 4].join(' ')).withBase("220:1")
 * // mini([1 / 1, 16 / 15, 9 / 8, 6 / 5, 5 / 4].join(' ')).mul(220).freq()
 *
 * @returns Pattern
 */
export const withBase = register('withBase', (b, pat) => {
  let base;
  let originalBase = 220;
  if (Array.isArray(b)) {
    base = b[0];
    originalBase = b[1];
  } else {
    base = b;
  }
  return pat.withHaps((haps) => {
    haps = haps.map((hap) => {
      let hVal = hap.value;
      const isObject = typeof hVal === 'object';
      let freq = isObject ? hVal.freq : hVal;
      freq = (freq * base) / originalBase;
      hap.value = isObject ? { ...hap.value, freq } : { freq };
      return hap;
    });
    return removeUndefineds(haps);
  });
});

/**
 * Frequency transpose. Assumes pattern either has `freq` set, or has values that can be interpreted as frequencies
 * amt has optional `edoSize` param, defaults to 12.
 * If haps have edoSize param set, such as from the output of `xen("31edo")`,
 * `ftrans` will fallback to that instead of 12 as the default.
 *
 * Transposes the frequency by `amt` edoSteps
 * @name ftranspose
 * @synonyms ftrans, fTrans, ftranspose, fTranspose
 * @tags tonal
 * @param {number} amt
 * @param {number} edoSize (optional)
 * @returns {Pattern}
 *
 * @example
 * i("0 1 2").xen("12edo").ftrans("7")
 * // n("0 1 2").scale("A:chromatic").trans("7")
 * @example
 * i("0 8 18").xen("31edo").ftrans("<8 -8>")
 * @example
 * // to transpose by steps of an edo, use "step:edo" :
 * i("0 7 8 18").xen("31edo").ftrans("<0 1:31 1:12>")
 * @example
 * // it can also work with frequency values directly
 * freq("200 300 400").ftrans("<0 7:31 7>")
 */

/* f = frequency (Hz)
  n = edo (steps per octave)
  x = number of steps
  if 0\n = f, then x\n = f * 2^(x/n)
  example: 5edo, 0\5 = 220 Hz, then 2\5 = 220*2^(2/5) = 290.29 Hz */

export const { ftrans, fTrans, ftranspose, fTranspose } = register(
  ['ftrans', 'fTrans', 'ftranspose', 'fTranspose'],
  (amt, pat) => {
    let edoSize;
    let numSteps;
    if (Array.isArray(amt)) {
      edoSize = amt[1];
      numSteps = amt[0];
    } else {
      numSteps = amt;
    }
    return pat.withHaps((haps) => {
      haps = haps.map((hap) => {
        let hVal = hap.value;
        const isObject = typeof hVal === 'object';
        hVal = isObject ? hVal : { freq: hVal };
        let { freq, ...otherValues } = hVal;
        if (edoSize == undefined && hap.context.edoSize != undefined) {
          edoSize = hap.context.edoSize;
        } else if (edoSize == undefined) {
          edoSize = 12;
        }
        freq = freq * Math.pow(2, numSteps / edoSize);
        freq = trimFreq(freq);
        hap.value = isObject ? { ...otherValues, freq } : freq;
        return hap.setContext({ ...hap.context, edoSize });
      });
      return removeUndefineds(haps);
    });
  },
);

// not sure there's a point to having this and the above, seems like a proto version of the above.
const tuning = register('tuning', function (ratios, pat) {
  return pat.withHap((hap) => {
    const frequency = xenOffset(ratios, parseNumeral(hap.value));
    return hap.withValue(() => frequency);
  });
});
