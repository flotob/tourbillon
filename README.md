# tourbillon

A desktop live music coding environment with a built-in agent, based on [Strudel](https://codeberg.org/uzu/strudel).
Tourbillon is an independent fork and is not affiliated with the Strudel project. See [NOTICE.md](NOTICE.md).

## Running the desktop app

Requires [Node.js](https://nodejs.org/) 22.19 or newer and [pnpm](https://pnpm.io/installation).

```bash
pnpm i
pnpm desktop        # dev: astro dev server + electron, with hot reload
pnpm desktop:prod   # builds the website, then runs electron on website/dist
```

The Electron shell lives in [desktop/](desktop/).

### Agent

The agent tab runs [pi](https://pi.dev) in the Electron main process ([desktop/agent/](desktop/agent/)), with editor
tools implemented in [website/src/repl/agent/](website/src/repl/agent/). Sign in with ChatGPT from the tab; the
credentials are stored in the app's data folder (`~/Library/Application Support/Tourbillon/agent` on macOS), never in
the repo. The agent writes into the editor but never evaluates: press Ctrl+Enter to hear its changes, Cmd+Z undoes an
agent edit.

### Tracks and data

A track is one code page. Open tracks are tabs above the editor: the app starts with one new empty tab, Cmd+N opens
another, Cmd+W closes one, a double click on a tab renames it, and a double click in the tracks list opens a track.
The tab whose code is playing shows a play icon. Edits are saved as you type,
and every evaluation (Ctrl+Enter) keeps a version in the track's history. Agent chats belong to a track. Everything is stored in one SQLite
file, `~/Library/Application Support/Tourbillon/tourbillon.db` on macOS ([desktop/db.mjs](desktop/db.mjs)), so copying
that file backs up all tracks, versions and chats.

For development:

- `TOURBILLON_AGENT_SCRIPT=scripts/agent-smoke.mjs pnpm desktop` replaces the model with a scripted one that runs every
  tool once, no account needed.
- `TOURBILLON_USER_DATA=/some/dir pnpm desktop` runs with a separate profile.
- `TOURBILLON_DEV_PORT=4400 pnpm desktop` runs a second dev instance next to the first.

Everything below is the original Strudel README.

---

# strudel

Live coding patterns on the web


- Try it here: <https://strudel.cc>
- Docs: <https://strudel.cc/learn>
- Source: https://codeberg.org/uzu/strudel/
  * Along with many other live coding projects, we have moved from Microsoft's Github platform to Codeberg for ethical reasons. **Please don't fork the project back to github**.
- Technical Blog Post: <https://loophole-letters.vercel.app/strudel>
- 1 Year of Strudel Blog Post: <https://loophole-letters.vercel.app/strudel1year>
- 2 Years of Strudel Blog Post: <https://strudel.cc/blog/#year-2>


## Running Locally

After cloning the project, you can run the REPL locally:

1. Install [Node.js](https://nodejs.org/) 18 or newer
2. Install [pnpm](https://pnpm.io/installation)
3. Install dependencies by running the following command:
   ```bash
   pnpm i
   ```
4. Run the development server:
   ```bash
   pnpm dev
   ```

## Using Strudel In Your Project

This project is organized into many [packages](./packages), which are also available on [npm](https://www.npmjs.com/search?q=%40strudel).

Read more about how to use these in your own project [here](https://strudel.cc/technical-manual/project-start).

You will need to abide by the terms of the [GNU Affero Public Licence v3](LICENSE). As such, Strudel code can only be shared within free/open source projects under the same license -- see the license for details.

Licensing info for the default sound banks can be found over on the [dough-samples](https://github.com/felixroos/dough-samples/blob/main/README.md) repository.

## Contributing

There are many ways to contribute to this project! See [contribution guide](./CONTRIBUTING.md). You can find the full list of contributors [here](https://codeberg.org/uzu/strudel/activity/contributors).

## Community

There is a #strudel channel on the TidalCycles discord: <https://discord.com/invite/HGEdXmRkzT>

You can also ask questions and find related discussions on the tidal club forum: <https://club.tidalcycles.org/>

The discord and forum is shared with the haskell (tidal) and python (vortex) siblings of this project.

We also have a mastodon account: <a rel="me" href="https://social.toplap.org/@strudel">social.toplap.org/@strudel</a>
