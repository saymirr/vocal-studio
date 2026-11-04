# vendor/

`lame.min.js` is **lamejs 1.2.1** (a JavaScript port of the LAME MP3 encoder), used only for MP3 export.

- Licence: **LGPL-3.0** — see `LICENSE-lamejs.txt`. Project: <https://github.com/zhuker/lamejs> · LAME: <https://lame.sourceforge.net/>
- It is kept as a **separate, unmodified file** and loaded at runtime only when you choose an MP3 format, as the LAME licence notes recommend. `index.html` itself contains none of its code.
- You can replace it with any other build of lamejs that exposes a global `lamejs.Mp3Encoder`.
- If this file is missing (for example you downloaded only `index.html`), the app falls back to the same pinned version on jsDelivr with an integrity hash; WAV export never needs it.
