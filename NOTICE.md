# Notice

Tourbillon is a modified version of [Strudel](https://codeberg.org/uzu/strudel),
copyright the [Strudel contributors](https://codeberg.org/uzu/strudel/activity/contributors),
licensed under the GNU Affero General Public License v3.0 or later (see [LICENSE](LICENSE)).

- Forked from upstream commit `7dd20fee57870b4ce2dd43bc22a3a009bbb63774` on 2026-10-24.
- All changes since then were made by the Tourbillon contributors and are recorded in the git history of
  <https://github.com/flotob/tourbillon>. Every commit after the fork point is a modification of the original work.
- Tourbillon is distributed under the same license, AGPL-3.0-or-later.

Tourbillon is an independent project. It is not affiliated with or endorsed by the Strudel project or the uzu
collective. Please do not report Tourbillon issues upstream, and do not submit Tourbillon code to Strudel:
Strudel's [policy](POLICY.md) declines contributions that contain LLM-generated content, and Tourbillon is developed
with AI assistance.

Sample libraries loaded at runtime are hosted by third parties and keep their own licenses.

The crate feature runs [crate](https://github.com/flotob/tourbillon-crate), a separate AGPL-3.0-or-later project that
uses Demucs and Beat This! (MIT), Essentia (AGPL-3.0) and the Rubber Band command line program (GPL-2.0-or-later). Records in the crate are derived from the user's own audio files and stay on their
machine; only import music you have the rights to use.

Drum patterns are found by [ADTOF](https://github.com/MZehren/ADTOF) (code and model weights under
[CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/), free for non-commercial use only). ADTOF is not
part of Tourbillon or crate and is not distributed with them: crate downloads it when the user first asks for drum
patterns, into its own environment, and runs it as a separate program.
