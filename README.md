# ememdemo

**Tokenise huge files for agents to use.**

The top half is one box. The bottom half is a gallery of real inputs and what they became, each re-checked live as the page loads.

The box takes anything:

| paste or drop | you get |
|---|---|
| files: PDF, scans and images (OCR), docx, pptx, xlsx, epub, html, md, txt, code, data | one link; large inputs become an **index** of sections, each listing the headings, pages or code symbols it covers |
| a URL, or a GitHub repo, folder or file | the same, read from the source (repos pinned to a commit or tag) |
| an emem link | the link re-checked: every file is re-hashed against its name |
| any emem token: `emem:fact`, `bundle`, `cell`, `entity`, `raster`, `cube`, `rasterset`, `state` | the record it names, resolved and its signature checked in the browser |
| a bare file name (26 characters) | the file, read by name over **A2A**, with its author's signature checked |
| a link to large data: model weights (safetensors, GGUF), GeoTIFF/COG/BigTIFF, OME-Zarr, HLS video, DICOM, MP4, PMTiles, Parquet, FlatGeobuf, NetCDF-3 (variables and records, with a map of the main field), NetCDF-4/HDF5, COPC lidar (octree nodes), Zarr v3 with sharding (inner chunks from each shard's crc32c-checked index), 3DGS `.ply`, or any file with byte ranges | a **pointer**: the data stays at its source; emem holds its address, chunk hashes and statistics |
| a Hugging Face repository or an S3 folder ending in `/` | a **listing** of every file with its publisher's content hash; nothing downloaded |
| several links, one per line | one index over all of them |
| `cameras: London` | 12 street cameras: each clip hashed again, the sun recomputed, the counts labelled as a detector's reading |
| `world: Cubbon Park, Bengaluru` | every layer emem measures there (satellites, radar, terrain, weather, air, buildings, a composite, algorithms), cross-checked, one handle |
| `more:`, `witness:`, `compare: A B` on pointers | a pointer extended, independently re-read and signed, or diffed against another |
| `ask: flood risk in Chennai` | a signed answer about a place, every fact it used, and one `emem:bundle` handle for all of it |

Every result comes with tabs an agent can use directly: **preview · AGENTS.md · chat · curl · MCP · A2A · check**. The `check` tab marks each "quote" in an AI's answer as found in the source or not.

## Every layer at a place

`world: <place>` (for example `world: Cubbon Park, Bengaluru`) asks emem.dev for everything it measures at one cell about 10 m across. The calls run at once, and each answer's receipt is checked in the page against the pinned key:

| layer | what | from |
|---|---|---|
| satellite, optical | red and near-infrared reflectance, NDVI | Sentinel-2 |
| satellite, radar | VV backscatter (through cloud, day or night) | Sentinel-1 |
| terrain | elevation (two independent models); slope, ruggedness, landform from the 3×3 neighbourhood | Copernicus DEM, GMRT; Horn 1981, Riley 1999, Weiss 2001 |
| weather, climate | air temperature, rain, wind now; reanalysis; land surface temperature day and night | met.no, ERA5, MODIS |
| air | PM2.5 | CAMS |
| the built world | buildings, named places, road length | Overture |
| composite | a cloud-masked median of every Sentinel-2 scene over the last 120 days, as an `emem:raster:` token anyone can rebuild pixel for pixel | emem `band_composite` |
| algorithms | every published formula whose inputs are present (water likelihood from radar, vegetation class, heat index, wind power…), with its value | emem's algorithm registry |

**Cross-checks.** Independent sources for the same quantity are set side by side:
- Copernicus DEM against GMRT elevation;
- NDVI recomputed in the page from red and near-infrared against emem's stored index and against MODIS;
- air temperature now against reanalysis and ground temperature.

Agreement is evidence; a gap is a finding. At Marina Beach, the NDVI recomputed from bands equals the stored index (0.0315).

Every fact is then bound into one `emem:bundle:` token. The reading is stored as a hash-named note (`emem: world.v1`), with one line per measurement and its `emem:fact:` token. Reopening it resolves the bundle again, checks its signature, and redraws the composite from pixels that hash to their name.

## The gallery: evidence you can see

Each card is a piece of real-world evidence, shown with a picture, a noun, the verbs that were applied to it (counted), and who keeps it. There is no descriptive prose.

| kind | examples |
|---|---|
| earth | the Amazon frontier, 2017–2025 in true colour (a timelapse of 15 signed rasters); Bengaluru in true colour (Sentinel-2, 351 MB); every layer at Cubbon Park |
| space | Webb's Cosmic Cliffs (144 MB), Hubble's Whirlpool (215 MB) and Sombrero (180 MB) galaxies, read strip by strip; Mars in December 2024 (Hubble); the Moon's terrain (Kaguya, USGS) |
| government | Amazon plots read against the EU deforestation cut-off (forest grid) |
| cities | Phoenix and Bengaluru as grids of green, heat and buildings, with the correlation measured |
| consumer | a holiday photo placed by its own EXIF (Nikon COOLPIX, Tuscany, 2008) |
| disaster | Lahaina before and after the 2023 fire (timelapse); the Maui fires at 50 cm (Maxar Open Data) |
| mines · cities · wildlife | the Kalgoorlie Super Pit, Lusail rising from sand, the Okavango flood pulse (timelapses); Maasai Mara, every layer |
| drones | dry-lake cracks from a drone survey (OpenAerialMap) |
| gatherings | 12 London street cameras, each clip re-hashed |
| commerce | an agent's purchase as an evidence track: quote → invoice → delivery port → evidence bundle, chained and stamped |
| robotics | an ALOHA robot episode file (MP4, 502 MB), 12 keyframes decoded from hashed bytes; the whole LeRobot dataset listed |
| wildlife | a lion and an impala in Kruger (iNaturalist, research grade), the Okavango flood pulse, Maasai Mara |
| 3d · medical · models | a million Gaussian splats; a CT slice in Hounsfield units; GPT-2, TinyLlama, a model comparison |

**Who keeps it**, one per card (enforced by `rule gallery`):
- `machine`: signed by a system (emem facts, the log, camera detectors);
- `third party`: a publisher's file named where it lives;
- `combined`: joined from several sources (world readings, timelapses, tracks, comparisons);
- `human`: a person's own file.

**Pictures** are `emem: thumb.v1` notes made by `tools/thumbs.mjs`, which opens each link in a real browser and keeps what the page drew from bytes it had just checked. A card shows a picture only if the note's name matches its bytes and the note names the card's link. Timelapses play as sprites.

**Live.** The header shows the size of emem's signed log, checked against the pinned key and refreshed every minute. The channel card streams agents' writes.

## Grids: cities and forests, square by square

- `city: <place>`: a 12 × 12 grid over about 6 km. Each square is a cell whose facts carry emem's signature: vegetation (Sentinel-2 NDVI), ground heat by day (MODIS), and buildings (Overture). The page then:
  - draws each band as a map;
  - computes the correlation between vegetation and ground heat over every square that has both (Pearson r);
  - draws the building footprints of the central square kilometre.
- `forest: <place>`: canopy in 2000 and year of loss (Hansen), plus vegetation now, read against the EU deforestation regulation (forest = canopy ≥ 10 %; cut-off 31 December 2020). It counts squares lost before and after the cut-off and adds emem's deforestation alert at the centre.

Squares are located in parallel (`/v1/locate`) and recalled in two passes (`/v1/recall_many`, the second collecting what the first left pending). Every square's receipt is checked, and each map's values are bound into one `emem:bundle:`. The grid is stored as `emem: grid.v1`. Reopening redraws the maps from the note and checks every bundle's signature.

## Video, photographs and observations

- **MP4:** the index (`moov`, at either end) names every frame. A keyframe group is a chunk, hashed with its frame count and bit rate. Keyframes are decoded in the browser with WebCodecs (AV1 or H.264) from the very bytes that were hashed, then played in order. Example: a LeRobot ALOHA episode file (502 MB).
- **JPEG:** the whole picture is hashed, and the preview is drawn from those bytes. EXIF gives the camera, the time and GPS. A photo with a place is tied to emem's cell and signed facts there. Example: a Nikon COOLPIX photo from Tuscany, October 2008.
- **Wildlife observations:** an iNaturalist observation URL points at its original photograph. The species, research grade, time, place, observer and licence come from the observation; the place from the observation ties it to a cell and emem facts. Example: a southern lion watching an impala in Kruger.

## Timelapses and tracks

- `timelapse: <place or lat, lng> [| 2017-2025 08]`: emem mints red, green and blue `emem:cube:` tokens over a square about 4 km across. A frame joins the three only where they chose the same Sentinel-2 scene, and its pixels must hash to their artifact names. One stretch serves every frame, so what changes is the ground. All rasters are bound into one `emem:rasterset:`. Reopening resolves the cubes, checks their signatures and re-hashes every frame.
- `track: <title>` then `<step>: <link or token>` per line: each step is re-checked where it stands, then chained (each link = blake3(previous link ‖ step)), so no step can be dropped, swapped or reordered. It is stamped after the log head. Reopening re-checks and recomputes the chain.

## Reading big colour images in place

GeoTIFFs with deflate RGB tiles (Sentinel-2 TCI) and JPEG-in-TIFF tiles (Maxar, OpenAerialMap, using the file's shared JPEGTables) decode in the browser. So do striped, LZW-compressed TIFFs (Hubble, Webb; the page carries its own TIFF LZW decoder). Mask IFDs are skipped. Each tile's statistics are the mean of each colour channel.

## Time, proven

Every result is stamped with emem's signed log head before it is signed: `after: sth <tree size> <root> <signed_at>`. Nobody knows a future root, so this is a lower bound on when the result was written.
- **Co-signing.** The writer's key co-signs that head (`POST /v1/log/witness`), so every visitor becomes a witness of emem's log.
- **Reopening.** The page fetches a consistency proof from the stamped head to today's head and checks it with the RFC 9162 algorithm and emem's hashing. It then reports "written after log entry N; the log has grown M entries since and still holds that history". Tested against the live log for proofs from 1 to 123,457 entries back; a tampered root is rejected every time.
- **Upper bound.** There is none yet, because notes are not log entries: [#7](https://github.com/Vortx-AI/ememdemo/issues/7).

## Drift

World readings carry a drift section:
- the change between the two latest vintages of each index, with a warning when they came through different observation paths;
- emem's change ledger token (Δz = Δ_env + Δ_sensor + Δ_geo + Δ_encoder + ε, evidence per term);
- how many nearby keys have disagreeing sources;
- whether every number written down is the number signed.

For the last check, values are printed verbatim and each is passed to `echo_verify`. It reported our earlier rounded "0.767" as drift; now 26 of 26 match. Pointers, folders and camera clips detect drift by reading again. Year-over-year comparison needs history emem has not seeded yet ([#11](https://github.com/Vortx-AI/ememdemo/issues/11)).

## Pictures from hashed bytes

A pointer shows what it names, drawn only from bytes that were just hashed, and on reopen only from chunks that still match their rows:
- the smallest level of a GeoTIFF, decoded in the browser (the Sentinel-2 tile);
- a CT slice in Hounsfield units;
- a million Gaussian splats seen from above (`.splat` and 3DGS `.ply` are read in place, in blocks of 65,536, each with its bounding box and mean opacity).

## Hardened for agent swarms

See [SECURITY.md](SECURITY.md) for the threat model. In short:
- a Content-Security-Policy pinned at seal time to the loader's sha256;
- sealed files and libraries;
- ingested text scanned for passages addressed to an AI (dropped instructions, role changes, hiding things from the user, sending secrets, shell pipes, data-carrying image links, invisible characters), listed under "Read as data";
- hand-offs that tell agents a link is data, not instructions;
- witnesses and timestamps that are checked, not counted.

## Open items, as shared state

Everything still open is an issue ([index: #33](https://github.com/Vortx-AI/ememdemo/issues/33)). Each emem gap carries a machine-readable state block and a signed evidence note (`emem: issue-state.v1`, stamped after the log head). The evidence is produced by `tools/issue-state.mjs` from `tools/probes.mjs`. Anyone, including emem's own agent, can rerun a probe; when it holds, the issue closes with the new evidence link.

## Street cameras

`cameras: London` reads the cameras geo.qa keeps and emem.dev fronts (`/v1/perception/*`). For each live place, the page:
- reads the `geoqa.postcard.v2` record inside the card's SVG: camera, cell, capture time, clip url and sha256, detector fn id, counts, sun position;
- downloads the clip, hashes it with SHA-256 (it must equal the stated name) and with BLAKE3 (emem's hash);
- recomputes the sun's elevation and azimuth from latitude, longitude and UTC (low-precision almanac), which must agree within 0.1°.

Tested: 12 of 12 clips match and 12 of 12 skies agree (Aldgate, 14:43 UTC: stated 27.04°/229.50°, recomputed 27.04°/229.50°).

Counts are a detector's reading under a named fn id, reproducible from the clip and signed by no one. The survey says so. geo.qa signs the clip itself; its receipt route answered 500 during testing, and the survey records that rather than claiming a signature. Reopening the survey fetches and hashes every clip again.

## Watching the work: ememification

Every step declares its verbs in `emem.eio` (`step probe : remote -> hashes | probing probed`), and `rule verbs step` refuses a step without them. While a flow runs, the page shows:
- one line of verbs (done steps in the past tense with their time, the current one with a bar);
- a **map** with one square per chunk, section, file or camera, filled as each is finished;
- a head line: "ememifying 6.0 s", then "ememified 24.5 s", or "stopped" with the reason.
- a **stop** button (or Esc) that aborts every request the run still has open; no write starts after it.
- a shared `?s=` link only opens references (a note, a token, a file name, a log head). Anything that would read a source or write is put in the box and waits for you to press →.
- nothing you drop, paste or choose is published until you press **Create public link**. The panel shows the title, the size, the first lines, your key and the exact name it will have. **keep it here** or Stop leaves nothing on emem.
- a stopped or failed run lists every write that was already accepted (those can't be undone), and keeps the previous result on screen, dimmed and labelled.
- the work head counts this run's requests and bytes read.
- the result separates **stored note** or **signed record** (what was checked of the stored bytes or the signature) from **checked now** (what was re-read from the source), with the time of the check.
- an index opens by checking its own name plus sections chosen at random here (first, last and two more). **check all** reads every section, and so does opening the check tab, since an answer is checked against the whole source.
- every result names who wrote it and that key's tier on emem's ladder (`GET /v1/enlist`). A key made here is T1 (keyed, unnamed). Witnesses are shown as a count of keys, not of parties. A key made here writes at most 400 notes an hour.
- OCR's worker, WASM core and English data are pinned by sha256 in the manifest like every other library, and loaded only from checked bytes, with no cache.
- copied commands quote every value as data. An ask result's handoff reads the frozen evidence bundle; asking again is a separate, labelled command.
- three ways in above the box: **point** a file, **sense** a place, **check** a link. Each one sets what the box expects.
- gallery cards are checked when they scroll into view, at most four at a time. A card's state names what was checked: `✓ note` (its bytes hash to its name; the source is re-read only when opened), `✓ receipt` (emem.dev signed it; that says who, not that it is right), or `unreachable` (not checked, which is different from a failed check).

The page itself boots the same way: before any of its code runs, the loader shows "ememifying this page" and fills one square per file as it matches the seal.

In every result, each `emem:` token and emem link is a button: one click resolves it in place, checked like any input.

## Folders: whole repositories and buckets

Paste a Hugging Face repository or an S3 folder (a URL ending in `/`). The page reads the **listing**, never the files, and stores `emem: directory.v1`:
- one row per file: path, url, size, and the **publisher's own content hash** (sha256 for Hugging Face LFS files, the git blob id for small ones, the S3 ETag);
- a Merkle root over `blake3(path, size, hash)`.

Opening it lists the folder again. Tested: with one ETag altered and one file removed from the listing, it reports "1 changed, 0 new, 1 gone, 19 unchanged". Any download can be checked against the kept hash; the curl tab shows how, and `config.json`'s git blob id was checked this way. A large file in the folder can be pointed at chunk by chunk.

## emem, tokenised

The gallery holds emem itself as links an agent can read:
- the whole emem.dev site: the whitepaper, 11 docs pages and llms.txt, 23 sections;
- the Vortx-AI/emem repository: 139 sections, about 641k tokens;
- the whitepaper alone;
- emem's registries (algorithms, sensors, sources, functions, topics);
- agent setup (agent card, quickstart, quick reference, limits).

Several links pasted one per line become one index. A repository over jsDelivr's 50 MB cap is listed through GitHub's own tree API and read from raw.githubusercontent.com, pinned to the commit.

## Large data, named where it lives

emem's principle is that the address stays separate from the data. Paste a link to large data and the page reads its **structure** by byte range, from the source. It hashes the chunks it reads and stores only a **pointer**: a few kilobytes on emem, while the bytes stay in the bucket, repository, microscope store or video server.

| source | a chunk is | example in the gallery | at the source → on emem |
|---|---|---|---|
| model weights (safetensors) | one tensor, found by the file's own header | GPT-2 on Hugging Face | 548 MB → 19.7 KB |
| model weights (GGUF) | one tensor, quantized or not, by its GGML block size | TinyLlama 1.1B, Q2_K | 483 MB → 10.6 KB |
| cloud-optimised GeoTIFF or BigTIFF | one tile at one zoom level | a Sentinel-2 band on AWS | 238 MB → 12.7 KB |
| OME-Zarr (microscopy) | one array chunk at one resolution level | IDR image 6001240 | ~28.5 MB → 11.5 KB |
| HLS video (CCTV, live feeds) | one segment, **hash-chained** so a live feed only extends | the Mux test stream | ~22.8 MB → 12.2 KB |
| DICOM (medical) | the header, then 1 MiB pixel blocks | a CT slice from pydicom's test data | 39 KB → 1.3 KB |
| anything with byte ranges | a 4 MiB range (streamed once if the server hides its size) | `point: <url>` forces this | |

**The pointer (`emem: pointer.v1`)** holds:
- the source URL, its size, and its ETag when the server exposes it;
- the structure it found: tiling, levels, axes, tensor count and parameter count, technical DICOM tags;
- one table row per chunk: url, offset, length, and BLAKE3-256 hash;
- one **Merkle root** over the rows, where each leaf binds `(url, offset, length, hash)`, or, for video, a **chain** where each link hashes the previous link with the next segment.

The pointer itself is a hash-named, signed note, so its name commits to all of it.

**Using it.** An agent reads only the rows it needs, straight from the source, by byte range, and compares hashes. The curl tab shows one row as a `curl -r` plus a one-line BLAKE3 check.

**Re-checking it.** Opening a pointer re-hashes the table against its root, then re-reads an even spread of chunks from the source. That is how a pointer detects data that changed after it was named. Tested: a clean source gives "6 of 6 sampled chunks still match"; one altered response gives "1 of 6 sampled chunks have CHANGED".

**Coverage, stated.** Large sources are sampled deterministically. Every small tensor, every overview tile and the smallest Zarr level are hashed completely; large tensors are sampled by the hash of their name and the largest raster level evenly. The pointer says `chunks: 107 of 161 hashed`, and the same input selects the same chunks and rows in any browser. The note's own name can still differ between runs, because each note is stamped with the log head it was written after (`after: sth …`); the rows and root don't change. DICOM pointers copy technical tags only (modality, size, spacing); patient fields stay at the source, and only their hash is recorded.

**Statistics per chunk.** Each hashed tensor, tile or pixel block also carries its mean, standard deviation, minimum and maximum, computed from the bytes that were hashed:
- float tensors (F32, F16, BF16) directly;
- deflate-compressed GeoTIFF tiles are inflated in the browser, horizontal differencing is undone, and nodata is left out (with the share of valid pixels);
- uncompressed 16-bit DICOM pixels are rescaled, in Hounsfield units for CT.

An agent can tell what a chunk holds before it downloads it.

**Tied to a place.** A GeoTIFF's tie point, pixel size and EPSG code give its projected corners. The page inverts UTM (or Web Mercator) to latitude and longitude, asks emem for the cell at the centre, and writes signed facts about that cell into the pointer. For the Sentinel-2 tile these are ground elevation, NDVI and 2 m air temperature, each as an `emem:fact:` token. The tile is then a place, not just a file. (Checked: tile 43PGQ's centre, 13.061 N 77.350 E, is just north-west of Bengaluru, as the tile grid says.)

**Coverage grows by reading.** "hash 8 more" writes a new pointer that names the one it `extends`. It keeps the earlier rows, re-reads two of them to be sure the source has not changed, and hashes the next 8. "Next" is fixed: defaults first, then by the BLAKE3 hash of each row's label, so two readers anywhere extend to the same rows.

**Witnesses.** "witness" makes this browser's key re-read 6 chunks from the source itself and sign what it found. The note is addressed to the pointer's author (`…/arcade/witness-<time>-to-<author>.md`, readable at `/v1/inbox`). Opening a pointer lists its witnesses, and each one counts only after its bytes and its Ed25519 signature check here. A witness says one more independent reader saw the same bytes; it does not make the data true. Your own key cannot witness your own pointer.

**Compare.** `compare: <pointer A> <pointer B>` matches rows by unit name (without type, shape or a `transformer.`-style prefix). Equal hashes mean equal bytes at both sources, so nothing is downloaded to decide it. One identical unit is still re-read from both sources. Large tensors are sampled by the hash of their name, not their position, so two models sample the same tensors. (Found: GPT-2 and distilgpt2 share one byte-identical sampled tensor, the causal mask `h.4.attn.bias`. The other 55 tensors both pointers hashed differ; their statistics show by how much.)

**Science, checked.** The GPT-2 pointer reports 137,022,720 parameters, not the familiar 124M. The file also stores 12 causal-mask buffers (`attn.bias`, 12 × 1024 × 1024 ≈ 12.6M values), so the pointer reports what the file holds.

## A website that proves itself

Most websites ask you to trust whoever serves them. This one checks itself before it runs.

- **Sealed.** `tools/seal.mjs` stores every file the page runs on emem.dev, each named by the hash of its bytes and signed by the site key. It also stores a **manifest** listing each file's sha256, plus the sha256 of every third-party reader the page may load (pdf.js, mammoth, SheetJS, JSZip, tesseract's entry module). `index.html` pins the manifest by its link and sha256.
- **Checked before running.** The loader in `index.html` uses only the browser's built-in SHA-256, so it trusts no library first. It then:
  - verifies the manifest against the pin;
  - verifies each file;
  - runs modules only from their verified bytes (blob URLs, with relative imports pointed at the verified copies);
  - checks third-party readers against the manifest before they run.
- **Self-healing.** If this site's copy of a file has been altered (a bad deploy, a compromised host), the loader fetches the true bytes from emem.dev and says so in the footer. If the manifest itself doesn't match the pin, the page refuses to run and says why. All three cases were tested: a normal load, a tampered `emem.mjs` (restored), and a tampered manifest (refused).
- **Host-independent.** `?boot=emem` runs the whole page from emem.dev alone; GitHub Pages only has to serve `index.html`.
- **Signed.** The footer shows `sealed · 9 of 9 files checked · signed by ddzmyzhn`. The manifest's author signature is checked over A2A.
- **In its own gallery.** The proof section has "This website, sealed"; opening it re-hashes the manifest the page is running from.
- **Exceptions, stated:**
  - `index.html` is the trust root and cannot seal itself; it is 60 lines and readable.
  - Tesseract fetches its worker, WASM core and language data itself, so only its entry module is pinned.
  - Images are not sealed.

**Changing the site:** edit, then run `EMEM_KEY_FILE=<site key backup> node tools/seal.mjs`, then commit. Without that, a sealed page restores the last sealed code from emem, which is the point. `?boot=local` runs unsealed code for development, and the footer says so.

## For agents: the same source, compiled twice

`emem.eio` compiles into the human page and, through `tools/seal.mjs`, into two files an agent can read:

- **`llms.txt`:** the whole site in about 3k tokens, written in **r1** lines (verbs first): the grammar, each note kind's schema by content id, the input verbs, the write and read calls, the signer key, and one brief line per gallery item, grouped by kind. Roots, bundles and stamps stay in the note, one fetch away.
- **`llms-full.txt`:** the same interface as prose, for a reader that wants it. It isn't needed to use the site.
- **`.well-known/agent-card.json`:** an A2A agent card whose skills run at emem.dev's A2A endpoint. The site has no server of its own.

Both are sealed with the site, so an agent can check them the same way.

### r1: one line per result

```
r1 <verb> <noun> <ref> key=value …        ref = <attester8>/<cid>  →  https://emem.dev/memories/by_attester/<ref>.md
r1 pointed cog ddzmyzhn/wkxa7tcmw2orf7ujjf5yi66dhe src=esawebb.org size=143.7MB hashed=97/1690 root=etmgt35lbn sth=2188509
r1 mapped forest ddzmyzhn/fss35xszeperjmoyxfqyeglr6i at=-9.72999,-63.03000 grid=12x12 bands=… receipts=144/144
```

Each note kind declares its schema in `emem.eio` as a `spec` block. The schema is stored once by its hash, and every new note carries `spec: <cid>`, so the page doesn't have to repeat prose in each note. Every result and gallery card has a **copy for agent** action that copies its line (about 30 tokens, against an average of about 2,900 for the notes themselves, measured on 11 gallery notes). `src/line.mjs` derives lines and is pure: the page, the seal tool and any agent get the same line from the same bytes.

| verb | noun | from |
|---|---|---|
| pointed | cog, bigtiff, safetensors, gguf, zarr, hls, dicom, mp4, jpeg, observation, splats, file | pointer.v1 |
| listed | folder | directory.v1 |
| sensed | place | world.v1 |
| mapped | city, forest | grid.v1 |
| framed | timelapse | timelapse.v1 |
| surveyed | cameras | camera.v1 |
| chained | track | track.v1 |
| diffed · witnessed · checked · drew | pointers · pointer · answer · thumb | compare, witness, check, thumb |
| indexed · stored | doc · text | index and text notes |
| resolve · pin · open | any emem token · log head · other links | tokens |

## Private links, keys and drift

- **Private links.** In the publish panel, **encrypt** seals every note with AES-256-GCM (`emem: sealed.v1`). The key travels only in the link's `#k=…` fragment, which browsers never send to a server. The note's name is still the hash of the stored ciphertext, so anyone can check integrity, but only a holder of the whole link can read it. An index and all its sections share one key; the agent line carries it as `key=`.
- **Keys.** The signing key is a non-extractable `CryptoKey` in IndexedDB: scripts on the page can sign with it but can't read it. A recovery file can be made only during setup (a new key, or one restored from a file), before the key is locked. After a reload the key is device-only. Old keys in `localStorage` are moved in once, and the plain copy is deleted. The site's own key is pinned in the loader (`SEAL.site`), so a seal by any other key is refused, and it is published in `.well-known/emem-agents.json`.
- **Drift chains.** `tools/drift.mjs` re-reads 6 chunks of every gallery pointer and appends a `drift.v1` note to that pointer's chain:
  - each entry names the one before it and records then/now hashes;
  - each is stamped after the log head;
  - entries are filed under `arcade/drift-<cid8>-<time>` in the watcher's folder;
  - `.github/workflows/drift.yml` runs it daily with the site key as a secret.

  Reopening a pointer reads the chain, checks every entry's author against the site key and that each names the previous one, and shows "recorded drift checks: n since …, every one held" (or when a change was seen).
- **Our own outputs, guarded.** World, grid, compare, timelapse, track and camera notes that cite emem tokens go to emem-guard before they are stored. The signed verdict is written into the note (`guard: allow · n citations · verdict signed by emem.dev`). A guard that can't answer is recorded as unavailable, never as allow.
- **Both ends of a note's time.** A note is stamped after the log head it was written against (lower bound). emem now logs every memory write, so reopening fetches the inclusion proof for the note's bytes and checks it against a signed head (RFC 9162: leaf = blake3(0x00 ‖ entry), node = blake3(0x01 ‖ l ‖ r)): "logged as entry M, written after the log held N entries and at most M−N entries later". Notes written before emem logged memory writes say they have no upper bound.
- **Outside oversight, stated.** The log counter's tooltip gives emem's own count of independent operators (distinct organisations) that co-signed the log, and whether the current head is independently witnessed. Today that is 1 operator, and the head is not independently witnessed.
- **Web pages, read by emem.** A page without CORS is read through `POST /v1/read`, which returns the text and the sha256 of the exact bytes emem fetched. The note records both, so anyone can check they got the same page. A third-party reader is used only when emem's text is cut short, and the note says so.
- **Heads you have seen.** The page remembers the log heads this browser saw and, on each visit, proves (RFC 9162) that today's log still holds every one. That is a per-reader check against a log that rewrites its past or shows readers different histories.
- **Back.** Each result is a place in history. Back reopens the previous reference, a read that never writes or re-runs a query.
- **Stop keeps work.** Stopping a pointer mid-way offers to keep the chunks already hashed as a partial pointer, in one explicit write. `more:` continues it in the fixed order.
- **Languages.** `lang es << … >>` in `emem.eio` holds a visitor-facing set of lines. The same rules check it (word counts, no jargon). Spanish and Hindi ship; `?lang=` picks one.

## Private buckets, grants, second readers and budgets

- **Private buckets.** A presigned URL (S3 `X-Amz-*`, GCS `X-Goog-*`, Azure `sig`/`se`/…) is used for this run and never stored. The pointer keeps the bare object URL and says `credential: presigned URL withheld`. Re-read it later with `<pointer link> with <fresh presigned URL>`, which is accepted only for the same object (same origin and path).
- **Per-agent grants.** Every browser has an X25519 **share key** (footer). In the publish panel, list share keys under "encrypt". Each one gets a `grant.v1` note: the link's key wrapped by ECDH with a fresh key, HKDF-SHA256 and AES-GCM. The grant link (`…#g=<writer8>/<cid>`) carries no key at all, and only that share key's holder can open it.
- **A second reader.** Reopening a pointer asks emem.dev to re-read one row at the source itself (`POST /v1/range_hash`). The page checks emem's signed receipt (PreimageV1 `emem.range_hash.v1`) and compares the hash with the row. The same row is proved to the note's root through `emem:tree` (`GET /v1/tree/{cid}`): the leaf is computed here from the row, then walked up the served path.
- **Grids, bound.** Reopening a grid checks that every row with a value names a cell in that band's signed bundle, and echo-verifies a spread of printed values against the facts the bundle cites. Phoenix: 420 rows are members, and 18 of 18 sampled values match.
- **Budgets.** `budget requests|bytes|seconds` in `emem.eio` caps each run. A run that reaches a cap stops itself like a Stop and says which cap it hit.
- **Live.** A live HLS pointer can **follow live**: it re-reads the playlist every minute, at most 30 times, one extension each. Segments are named by media sequence, and rows whose segments have left the playlist are kept, so the chain grows. A camera survey can **refresh every 5 min**, at most 12 times. Stop ends either.
- **Folders.** A listing records whether it was complete. A truncated re-listing reports files it didn't reach as "not reached", never as gone.

## Agents together: request, claim, deliver, verify

Agents can hand work to each other with no coordinator, following emem's agent-to-agent standard v2:
- full keys are pinned at first contact;
- authorship is verified offline;
- hand-offs are made as tokens;
- claims are re-derived, never taken from prose.

| type | writes | who may |
|---|---|---|
| `ask <52-char key> to witness: <ref>` | `request.v1`, addressed `A -> B` so emem's inbox delivers it | anyone; an 8-character prefix is refused (display-only, grindable) |
| `claim: <request>` | `claim.v1` | optional; stops a swarm repeating work |
| `deliver: <request> <result>` | `deliver.v1` with the result's r1 line | only the key the request named |
| `tasks: <request>` | nothing; it reads | anyone |
| **verify** (a button on each delivery) | `verify.v1` with the verdict | any key but the deliverer |

The task's state (requested → claimed → delivered → verified by n keys) is never stored. It is derived each time:
1. read claims and deliveries from the requested key's own folder, and verifications from the request's thread (`/v1/inbox?in_reply_to=<request cid>`; every hop carries `In reply to:`) (`arcade/deliver-<request cid8>-…`), which only that key can write, so junk sent to the requester can't hide them; read verifications from the requester's inbox, in full, as a count of keys;
2. check each note's bytes and its author's signature against the key it names;
3. check that a delivery comes from the requested key;
4. re-derive what the delivery points at. For a witness request, the result must be a witness of that pointer, and one that held.

"Verified by n keys" counts T1 keys (keyed, unnamed), not parties.

Specs for all four kinds are in `emem.eio` and in `llms.txt`.

## Checks that leave proof

- **emem-guard.** When an answer cites emem tokens, the check tab sends it to emem-guard, which resolves every citation and returns a signed **allow** or **deny** with a reason code. The page checks that verdict against the pinned key. Tested: "Bengaluru's elevation is 915.07 m (emem:fact:…)" gets **allow**; the same sentence with 870 gets **deny PROV_VALUE**.
- **Seal this check.** One click publishes the findings as a signed, hash-named note (`emem: check.v1`). It holds the answer, a pointer to the source, the guard verdict and every finding, so anyone can recompute it. The chat prompt asks the AI to cite the emem token next to each number, so answers become guard-checkable.
- **Your key.** The footer can **back up** the browser's key to a file and **restore** it elsewhere. Whoever holds the file can write as you.

## The gallery

There are 25 cards in 8 kinds (24 when unsealed): documents, in place, code, scans, places, agents, web, proof.

- **All cards:** on load, each card re-hashes or re-verifies its result and shows the outcome (✓ or ✗). `open` loads it into the box.
- **"Run it yourself":** on file and URL cards, this feeds the original input through the pipeline again. Section notes of a fixed input keep the same names in any browser. The index and single-file notes carry the log head they were written after, so their names change with each run, and "same file names as the gallery copy" shows only when nothing was stamped differently.
- **Places:** a signed elevation fact, a four-reading bundle, and a cube of Sentinel-2 pixels drawn from the signed grid (whose bytes hash to their name). There is also an entity, and a live question about a place.
- **Agents:** the standard two agents ratified, read by name over A2A, and **the public channel, live**: every note any agent writes, as it is written, links from this page included.
- **Proof:** emem.dev's transparency log head, with its signature checked in the browser, and **a file whose name lies**, so you can see a failed check.

The gallery's links were made with this page's own pipeline under one gallery key (`ddzmyzhn`). The sample files are in `samples/`; they were made for this page, so there are no licence strings attached.

## Proof, and who is trusted

- **Notes:** every file is named by `base32(blake3(bytes)[0:16])`. Anyone can re-hash it.
- **Receipts:** checked in the browser with **emem's own verifier** (`src/vendor/emem-verify-core.js`, Apache-2.0). It is vendored, so the page checks signatures with code it ships.
- **Signer:** the expected key is pinned in `emem.eio` (`signer 777er3yi…`). A receipt signed by any other key does not count.
- **Fact and raster bytes** are re-hashed against their ids.
- **States** have no signature; the page checks that their bytes hash to their name, and says so.
- **Notes read by name** have their author's ed25519 signature checked.
- **The log head's** signature is checked; the curl tab shows how to prove later that the log only grew.

A signature proves who wrote the bytes, not that the claim is true.

## The maths, stated

- **Names.** A file's name is the first 128 bits of BLAKE3 over its bytes, base32. Making different bytes with the same name takes about 2^128 tries (second preimage). The chance that two of a billion files collide by accident is about 1.5·10⁻²¹ (birthday bound).
- **Hash tree.** An index lists every section by its name, so the index's own name commits to the whole document. Change one byte in one section and that section's name changes, so the index's name changes too. Opening a link re-hashes the index and every section.
- **Signatures.** Ed25519 via emem's own verifier. The signer must equal the key pinned in `emem.eio`.
- **Token counts.** `tokens ≈ 1.10·words + 2.21·digit-runs + 0.57·punctuation + 0.33·newlines`. This was fitted by least squares against the o200k tokenizer on 60 of this gallery's files and tested on the other 30:

  | method | median error | 90th percentile |
  |---|---|---|
  | this fit | 4.8% | 9.8% |
  | length / 4 (before) | 15.8% | 29.8% |

  Claude's tokenizer differs from o200k, so read counts as estimates.
- **Index terms.** Each index entry also lists up to five distinctive terms: words frequent in that section and rare in the others, ranked by tf·idf with idf = ln(N/df). This matters most for sections with no headings.
- **Answer check.** It reports three independent measures:
  - **Quotes:** exact matches after normalizing whitespace, quote marks and markup. An ellipsis splits a quote into parts that must appear in order.
  - **Sentences:** the share of each sentence's 3-word runs that occur in the source. At 60% or more it traces word for word. A faithful paraphrase scores low, which is the honest reading: it cannot be traced mechanically.
  - **Numbers:** a number in the answer counts only if the source has it within ±250 characters of at least two of that sentence's other content words. A number that appears somewhere in the source does not count unless it sits next to what the sentence says. (Tested: "RFC 9110 defines 63 status codes" is flagged; 422, 9110, 2022 and 7231 hold.)

## Principles, as rules the page enforces

`src/eio.mjs` refuses to render if `emem.eio` breaks a rule, and names the rule:

| principle | rule |
|---|---|
| The hero says what goes in, what comes out, and who uses it. Short. | `rule words say 6..12`, `rule words sub 12..32` |
| No insider words before there is a result | `rule plain say in note blank : cid blake3 ed25519 hash signed token …` |
| Every step is declared, implemented, and its types connect | `rule typed make open resolve ask point extend witness compare world cameras timelapse track`, `rule verbs step` |
| Every output carries the result | `rule carry give : {link} {index} {curl} {mcp} {a2a}` |
| Every gallery card opens something the page can open, and runs only files it can read | `rule gallery show` |

## eio: the language the site is written in

`emem.eio` is the whole site: copy, header links, the token family, file kinds, limits, typed steps, flows, output tabs, gallery and rules.

```
link   A2A  https://emem.dev/a2a
token  fact : one signed measurement at a place | POST /v1/memory_token/resolve {"token":"{token}"} | emem_memory_token_resolve
step   split : docs -> sections
flow   make  : read text split sign store link
give   A2A << … {a2a} … >>
show   places : Bengaluru, ground elevation << tag emem:fact · emem emem:fact:… · pin a signed fact >>
rule   gallery show
```

## Files

| file | role |
|---|---|
| `emem.eio` | the site |
| `index.html` | the loader: checks every file against the pinned seal before running it |
| `src/lang.mjs` | the eio compiler, pure, shared by the page and the seal tool |
| `src/eio.mjs` | rules, page, flows, gallery, checks |
| `tools/seal.mjs` | seals the site on emem, stores the specs, and compiles `llms.txt`, `llms-full.txt` and the agent card |
| `src/line.mjs` | r1 lines: one verb-first line per note or token, pure |
| `src/hand.mjs` | agents together: request, claim, deliver, verify; the task's state derived from signed notes |
| `src/grid.mjs` | city and forest grids: sample locations, units as the facts state them, correlation with its exclusions |
| `src/read.mjs` | any input becomes markdown with headings, then sections and an index |
| `src/reel.mjs` | timelapses: RGB cubes, verified frames, one rasterset |
| `tools/thumbs.mjs` | gallery pictures as verified thumb notes |
| `src/time.mjs` | log-head stamps, co-signing, RFC 9162 consistency proofs |
| `tools/probes.mjs`, `tools/issue-state.mjs` | open items as rerunnable probes; results stored as signed state notes |
| `SECURITY.md` | threat model |
| `tests/`, `.github/workflows/test.yml` | offline unit tests and live browser tests, run in CI |
| `tools/drift.mjs`, `.github/workflows/drift.yml` | daily drift chains for gallery pointers |
| `.github/workflows/seal.yml` | reseals from main with the site key as a secret |
| `src/camera.mjs` | street cameras: geo.qa postcards, clips re-hashed, sun recomputed |
| `src/world.mjs` | every layer at a place: recall, terrain, composite, algorithms, cross-checks, one bundle |
| `src/point.mjs` | large data named where it lives: structure readers (COG/BigTIFF, Zarr, HLS, safetensors, GGUF, DICOM), chunk hashes and statistics, Merkle root or chain, place, extend, re-check, compare |
| `src/emem.mjs` | the wire: names, keys, signed writes, reads, the token family, proofs, ask, the channel feed |
| `src/vendor/` | emem's verifier, pinned (Apache-2.0) |
| `src/img/` | the emem mark, from Vortx-AI/emem |
| `samples/` | the gallery's sample files |

## Wire, exactly

- **Write:** `POST https://emem.dev/a2a/tasks {"skill":"emem_memory_create",…}`, signed with a browser Ed25519 key. `/mcp` refuses browser origins. Writes are paced under emem's per-key limit.
- **Read:**
  - a plain `GET` of the link;
  - A2A `emem_memory_view {"file_cid"}`;
  - MCP on `https://emem.dev/mcp/full`.
- **Tokens:** resolved per the rows in `emem.eio`; receipts checked client-side.
- **Ask:** `POST /v1/ask` with `Accept: text/event-stream`. The steps stream in (the place, then the facts, then the answer), and the cited facts are bundled with `POST /v1/memory_bundle`.
- **Channel:** `EventSource /v1/memory/sse?path_prefix=/memories/by_attester/`, seeded with A2A `emem_memory_list_by_kind`.

## Limits, stated

- **Hashing happens in the reader's browser.** Every byte hashed crosses the network once. Hashing next to the data (in the bucket's region, or on the microscope's own server) is roadmap, not shipped.
- **Witnesses are keys, not people.** Anyone can make keys; a witness count shows independent re-reads, not independent parties.
- **Everything written is public.** Deleting only unpublishes.
- **Size:** 4 MB of text and 160 sections per link.
- **OCR:** English only, first 40 pages. The recognizer (7 MB) loads on first use.
- **Ask** only answers questions about places, and takes 2–30 s depending on how warm emem.dev is.
- **Not supported:** `emem:trace` / `emem:attestation` have no public examples, so the page does not claim to resolve them. `emem:state` has no MCP tool; the page says so.
- **Chat apps:** plain ChatGPT, Claude or Gemini sessions may decline to open links. Coding agents, MCP and A2A clients do open them.

## Tests

`npm test` runs `tests/unit.mjs` (offline: the eio compiler, specs, r1 lines, the handoff grammar) and `tests/browser.mjs`. The browser tests drive headless Chromium against live emem.dev, and each case retries once:
- seal states: normal, a flipped byte in a site file, a flipped byte in the manifest, boot from emem only;
- rule breaks;
- a lying file name;
- shared-link gating;
- the publish gate;
- index sampling with "check all".

`.github/workflows/test.yml` runs both on every pull request.

## Run

It's a static site served by GitHub Pages from the repository root. To run it locally: `python3 -m http.server`.
