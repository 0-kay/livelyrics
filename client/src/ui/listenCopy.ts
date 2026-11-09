/** Upbeat copy for the waiting screen, rotating every few seconds. */
export const BUFFER_COPY = ["Play it loud, I'm listening!", 'Warming up the mic…', 'Ooh, I think I know this one!'] as const;
export const SEARCH_COPY = ['Checking my songbook…', 'Hmm, hmm, hmm…', 'So close!'] as const;
export const LONG_COPY = ['Move a little closer to the speaker!', 'Turn it up a notch!'] as const;
export const MISS_COPY = 'Not yet! Turn it up a bit';

/** Seconds each line stays up. */
export const COPY_SLOT_S = 3.5;
/** After this long without a match, switch to helpful nudges (seconds). */
export const LONG_WAIT_S = 15;
/** How long the "not yet" line stays after an empty check (seconds). */
export const MISS_SHOW_S = 2.5;

export interface ListenCopyInput {
  /** Seconds since Listen was tapped. */
  elapsedS: number;
  /** Seconds of audio in the buffer. */
  bufferedS: number;
  /** Seconds of audio sent per check. */
  clipS: number;
  /** Seconds since the last empty check, or null. */
  missAgoS: number | null;
  /** True once at least one check has been sent. */
  checked: boolean;
}

export interface ListenCopy {
  searching: boolean;
  copy: string;
  caption: string;
  /** Seconds since the current copy line appeared, for its entrance animation. */
  slotS: number;
  /** Ring fill, 0 to 1. */
  fill: number;
  /** Seconds since searching began, for the sweep fade-in. */
  searchAgeS: number;
}

export function listenCopy(inp: ListenCopyInput): ListenCopy {
  const { elapsedS: t, clipS } = inp;
  const fill = Math.min(1, Math.max(0, inp.bufferedS / clipS));
  const searching = inp.checked || fill >= 0.995;
  const searchStart = Math.min(t, clipS);
  if (!searching) {
    const i = Math.floor(t / COPY_SLOT_S);
    return {
      searching, fill, searchAgeS: 0,
      copy: BUFFER_COPY[i % BUFFER_COPY.length],
      slotS: t - i * COPY_SLOT_S,
      caption: `Listening · ${Math.min(clipS, Math.floor(inp.bufferedS))}s of ${clipS}s`,
    };
  }
  const searchAgeS = Math.max(0, t - searchStart);
  if (t >= LONG_WAIT_S) {
    const i = Math.floor((t - LONG_WAIT_S) / COPY_SLOT_S);
    return {
      searching, fill, searchAgeS,
      copy: LONG_COPY[i % LONG_COPY.length],
      slotS: t - LONG_WAIT_S - i * COPY_SLOT_S,
      caption: 'Still listening · checking every 2s',
    };
  }
  if (inp.missAgoS !== null && inp.missAgoS < MISS_SHOW_S) {
    return { searching, fill, searchAgeS, copy: MISS_COPY, slotS: inp.missAgoS, caption: 'No match yet · still listening' };
  }
  const i = Math.floor(searchAgeS / COPY_SLOT_S);
  return {
    searching, fill, searchAgeS,
    copy: SEARCH_COPY[i % SEARCH_COPY.length],
    slotS: searchAgeS - i * COPY_SLOT_S,
    caption: 'Matching…',
  };
}
