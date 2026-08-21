# Bible Bubble

An infinite canvas for tracking **who came from who**.

Make a bubble for a person, write down their age, their references and what they
were known for, then link them to their sons and daughters. The line grows as you
go, and at any point you can trace a name back to its root or drop the whole
board onto one timeline and see which lives overlapped.

Built as a personal note-taking and memory device: everything you write stays in
your own browser, and the whole app is a handful of static files with no build
step, no dependencies and no account.

![The canvas, with Noah selected](docs/canvas.png)

---

## Try it

**Open `index.html`.** That is the whole install — clone or download the repo and
double-click the file, or serve the folder:

```bash
git clone https://github.com/ilyakarakotov/bible-bubble.git
cd bible-bubble
python3 -m http.server 8000   # then open http://localhost:8000
```

To put it online, switch on GitHub Pages for the repository
(**Settings → Pages → Deploy from a branch → `main` / root**) and it serves as-is.

On first run it offers to start you from **Adam** with 105 people already filled
in — the line down to Jesus, with ages, dates, scripture references and
highlights — or to hand you an empty canvas.

---

## What it does

### The canvas
Pan by dragging, zoom with the wheel, and double-click anywhere to add a person.
Each bubble carries a name, a role, when they lived, scripture references, a list
of highlights and free-form notes.

### Linking a lineage
Hover a bubble and four handles appear. **Drag the ↓ handle onto empty canvas and
you get a new child, already linked and waiting for a name** — that is the fast
way to build a line. Drag a handle onto an existing bubble to link the two
instead. ↑ adds a parent, the side handles add a spouse.

The graph refuses to make anyone their own ancestor, so a mis-drag cannot
silently corrupt the tree.

### Tracing a line
Select someone and hit **T**. Their ancestors and descendants stay lit, everyone
else dims, and the panel shows the chain of descent — `Adam › Seth › Enosh › …` —
with every name clickable.

![Tracing a line of descent](docs/trace.png)

### The timeline
Every life on one axis. Because Genesis gives exact ages, the antediluvian
staircase and the collapse in lifespans after the Flood are visible at a glance.

Turn on the **year scrubber** and drag it to ask *who was alive in this year* —
the answer, with each person's age at that moment, appears along the bottom. It
is how you find out that Shem was 459 when Abraham was 9, and that Methuselah
died in the very year of the Flood.

![The timeline with the year scrubber](docs/timeline.png)

### Everything else
Multiple boards, full undo/redo, search across names, notes and references, a
lineage outline in the sidebar, a tidy auto-layout that arranges the whole board
into generations, light and dark themes, and export to JSON, Markdown or CSV.

![Dark theme](docs/dark.png)

---

## Keyboard

| | |
|---|---|
| `N` | New person |
| `T` | Trace the selected line |
| `L` | Tidy into generations |
| `F` | Fit everything on screen |
| `0` | Back to the head of the line |
| `G` | Toggle the grid |
| `/` | Search |
| `1` `2` | Canvas / timeline |
| `⌘Z` `⇧⌘Z` | Undo / redo |
| `⌘A` `⌘D` | Select all / duplicate |
| `Delete` | Remove the selection |
| `?` | All shortcuts |

Shift-drag marquee-selects. Space-drag pans while the cursor is over bubbles.

---

## Your notes stay yours

Boards are saved to `localStorage` in your browser. Nothing is uploaded, there is
no server and no account. That also means **clearing your browser data clears
your boards**, so use *Export as JSON* from the ☰ menu to back one up or move it
to another machine. Markdown export gives you the whole lineage as an indented
outline you can paste into any notes app.

---

## About the dates

Years are stored as **AM** — years from creation — because Genesis 5 and 11 give
the early chain exactly: each father's age when his son was born, and his age at
death. That fixes every date from Adam to Abraham relative to one another, and
those figures are used verbatim.

Everything after Abraham is marked *approximate* and rests on the traditional
anchor of **AM 0 = 4004 BC**. The kings of Judah are dated from their own
notices — "X years old when he began to reign, and he reigned Y years". Where
Matthew's genealogy telescopes generations (Joram to Uzziah, Josiah to Jeconiah),
the omitted kings are included as real people, with a note on the bubble saying so.

The anchor is a setting, not a doctrine: change it under **☰ → Board settings**
(3760 BC for the Hebrew calendar, or anything you like) and every date re-reads
without the stored years moving. Every figure in the starter board is editable —
it is a starting point, not a reference work.

---

## Layout

```
index.html          markup and the icon sprite
css/app.css         one stylesheet, themed with custom properties
js/util.js          helpers, the palette, year parsing and formatting
js/store.js         document model, validation, undo history, localStorage
js/seed.js          the Adam-to-Jesus starter board
js/lineage.js       graph queries and the generational layout
js/canvas.js        viewport, bubbles, links, dragging, minimap
js/inspector.js     the detail and editing panel
js/timeline.js      the timeline and the year scrubber
js/sidebar.js       lineage outline and people list
js/io.js            JSON / Markdown / CSV
js/app.js           toolbar, menus, search, shortcuts
test/smoke.js       end-to-end browser test
```

Plain ES5-compatible scripts on a `BB` namespace — no bundler, no framework, no
network requests at runtime.

---

## Tests

An end-to-end test drives the real app in a headless browser and fails on any
console error:

```bash
npm install --no-save playwright
node test/smoke.js          # HEADED=1 to watch it
```

It covers loading the starter board, search, tracing, the timeline and scrubber,
building a line by dragging handles, cycle refusal, editing that survives a
reload, the auto-layout leaving no overlaps, board switching, and import
sanitising malformed files.

---

## Licence

MIT — see [LICENSE](LICENSE).
