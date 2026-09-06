# Vendored patches

`xterm-6.1.0-beta.289-linux-ime.patch` is derived from Orca's xterm patch at
commit `e84042572` and is backported to beta.289. It retains the stock composition overlay and excludes unrelated SortedList/render-gate changes.

`scripts/build-xterm-linux-ime.mjs` builds the checked-in Linux-only ESM bundle from the pinned beta.289 npm sources and this patch, including Tessera's existing touch-scroll/mouse-coordinate safeguards. Windows, macOS and Android continue to load the stock npm bundle. Run `npm run vendor:xterm-linux-ime` to regenerate it. Orca is available at
<https://github.com/stablyai/orca> under the MIT License.

Copyright (c) 2026 Lovecast Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
