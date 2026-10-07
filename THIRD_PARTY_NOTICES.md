# Third-party notices

## Audio

The six chimes in `assets/sounds/` and their base64 copies in
`client/sounds.generated.js` are derived from **Kenney "Interface Sounds" (1.0)**,
released under **Creative Commons Zero (CC0 1.0)** —
<http://creativecommons.org/publicdomain/zero/1.0/>.

- Upstream: <https://kenney.nl/assets/interface-sounds> (created/distributed by Kenney, 2020-02-11)
- Mirror used for the pinned build input: <https://github.com/Calinou/kenney-interface-sounds>, commit `4596a49eaf5a533948d49a47467f606bcdea70ff`
- Upstream files: `confirmation_002`, `confirmation_001`, `confirmation_004`, `error_005`, `error_007`, `bong_001`

`scripts/generate-sounds.ts` downloads exactly those files from the pinned commit
and derives the shipped chimes: downmix to mono, resample to 22050 Hz, trim
silence, 4 ms/12 ms fades, normalize to −1 dBFS. Re-running the generator from the
same commit reproduces the same bytes.

Kenney asks for credit but does not require it; this notice credits Kenney anyway.

## Dependencies

`@deepseek-ai/schemastery` (Apache-2.0, shipped by DSH itself) is the package's
only runtime dependency. The browser half requires nothing beyond the platform
React runtime the DSH web shell already provides.
