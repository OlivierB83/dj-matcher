import { spawn } from "child_process";

function run(command, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(command, args, {
      stdio: "inherit",
      shell: false,
    });

    p.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} a échoué`));
    });
  });
}

async function checkBackend() {
  try {
    const res = await fetch("http://127.0.0.1:3001/api/known-tracks");
    return res.ok;
  } catch {
    return false;
  }
}

async function main() {
  console.log("🚀 DJ Matcher Catalog Pipeline");
  console.log("");

  const backendOk = await checkBackend();

  if (!backendOk) {
    console.log("❌ Backend non joignable.");
    console.log("Lance d’abord dans une autre fenêtre :");
    console.log("");
    console.log("node server.js");
    return;
  }

  console.log("1/2 Import des playlists Spotify...");
  await run("node", ["playlist-batch-importer.js"]);

  console.log("");
  console.log("2/2 Enrichissement du catalogue...");
  await run("node", ["catalog-builder.js"]);

  console.log("");
  console.log("✅ Pipeline terminé");
}

main();