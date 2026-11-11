/**
 * Interactive creation of an ADMIN account (first administrator).
 *   npm run create-admin
 *   npm run create-admin -- --username ADMIN01
 *
 * The password is typed twice with hidden input. It is never given on the
 * command line, never stored in a file and never printed.
 * Run it from Windows Terminal / PowerShell / cmd (an interactive console).
 */
import { loadEnv } from "./env";

loadEnv();

function ask(question: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(question);
    let buffer = "";
    const onData = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      for (const ch of text) {
        if (ch === "\r" || ch === "\n") {
          process.stdin.off("data", onData);
          process.stdout.write("\n");
          resolve(buffer);
          return;
        }
        buffer += ch;
        process.stdout.write(ch);
      }
    };
    process.stdin.on("data", onData);
  });
}

function askHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(question);
    let buffer = "";
    const onData = (chunk: Buffer) => {
      for (const ch of chunk.toString("utf8")) {
        if (ch === "\u0003") {
          process.stdout.write("\nAnnulé.\n");
          process.exit(130);
        }
        if (ch === "\r" || ch === "\n") {
          process.stdin.off("data", onData);
          process.stdout.write("\n");
          resolve(buffer);
          return;
        }
        if (ch === "\u007f" || ch === "\b") {
          buffer = buffer.slice(0, -1);
          continue;
        }
        buffer += ch;
      }
    };
    process.stdin.on("data", onData);
  });
}

async function main() {
  if (!process.stdin.isTTY) {
    console.error("Cette commande doit être lancée dans une console interactive (PowerShell, cmd ou Windows Terminal).");
    process.exit(1);
  }
  const { createUser } = await import("../lib/server/services/users");
  const { prisma } = await import("../lib/server/db");

  const argIndex = process.argv.indexOf("--username");
  process.stdin.setRawMode(true);
  process.stdin.resume();

  const username = argIndex > 0 && process.argv[argIndex + 1] ? process.argv[argIndex + 1] : await ask("Identifiant administrateur : ");
  const displayName = await ask("Nom affiché (optionnel) : ");
  const password = await askHidden("Mot de passe (min. 8 caractères, masqué) : ");
  const confirm = await askHidden("Confirmer le mot de passe : ");
  process.stdin.setRawMode(false);
  process.stdin.pause();

  if (password !== confirm) {
    console.error("Les mots de passe ne correspondent pas. Aucun compte créé.");
    process.exit(1);
  }
  try {
    const user = await createUser(null, { username, displayName: displayName.trim() || null, role: "ADMIN", password });
    console.log(`Administrateur créé : ${user.username}`);
  } catch (e) {
    console.error(`Échec : ${e instanceof Error ? e.message.split("\n")[0] : "erreur inconnue"}`);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

void main();
