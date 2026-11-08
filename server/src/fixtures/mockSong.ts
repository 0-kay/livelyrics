import type { TrackMatch } from '@livelyrics/shared';

/**
 * Invented placeholder song used by the mock providers. The title, artist and
 * lines are original test text written for this project, not a real song.
 */
export const MOCK_TRACK: Omit<TrackMatch, 'playOffsetMs'> = {
  title: 'Paper Lanterns',
  artist: 'The Mock Ensemble',
  album: 'Fixture Sessions',
  durationMs: 180_000,
  isrc: 'XX0000000001',
  score: 100,
};

export const MOCK_LRC = `[ti:Paper Lanterns]
[ar:The Mock Ensemble]
[al:Fixture Sessions]
[length:03:00]
[00:00.00]
[00:08.00]Test line one, the kettle starts to hum
[00:12.50]Test line two, the porch light says come home
[00:17.00]Counting tiles along the kitchen floor
[00:21.50]Someone left a lantern by the door
[00:26.00]
[00:30.00][01:30.00]Paper lanterns, drifting slow
[00:34.50][01:34.50]Carry every word we know
[00:39.00][01:39.00]Paper lanterns, burning low
[00:43.50][01:43.50]Light the way and let it go
[00:48.00]
[00:52.00]Verse two begins where the hallway bends
[00:56.50]Mismatched socks and borrowed pens
[01:01.00]Every clock is running five past late
[01:05.50]Still we laugh and still we wait
[01:10.00]
[01:48.00]
[01:52.00]Bridge line, softly, one more time
[01:58.00]Bridge line, slower, out of rhyme
[02:04.00]
[02:10.00]Paper lanterns, drifting slow
[02:14.50]Carry every word we know
[02:19.00]Paper lanterns, burning low
[02:23.50]Light the way and let it go
[02:28.00]
[02:40.00]End of fixture
`;

export const MOCK_TRANSCRIPT = 'paper lanterns drifting slow';
