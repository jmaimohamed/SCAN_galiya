// Refuses to start when the chosen port is already in use. Never kills anything.
import net from "node:net";

const port = Number(process.argv[2]);
if (port !== 3006 && port !== 3007) {
  console.error(`[galia-control] Port ${process.argv[2]} non prévu. Ports autorisés : 3006 (défaut) ou 3007.`);
  process.exit(1);
}

const server = net.createServer();
server.once("error", (err) => {
  if (err.code === "EADDRINUSE") {
    const other = port === 3006 ? 3007 : 3006;
    console.error(`\n[galia-control] Le port ${port} est déjà utilisé par un autre programme.`);
    console.error(`  Aucun processus n'a été arrêté.`);
    console.error(
      other === 3007
        ? `  Utiliser le port alternatif : npm run start:3007  (ou npm run dev:3007)`
        : `  Utiliser le port par défaut : npm start  (ou npm run dev)`,
    );
    console.error(`  Penser à ajouter http://<hôte>:${other} dans APP_TRUSTED_ORIGINS si ce n'est pas déjà fait.\n`);
    process.exit(1);
  }
  console.error(`[galia-control] Vérification du port ${port} impossible : ${err.message}`);
  process.exit(1);
});
server.once("listening", () => server.close(() => process.exit(0)));
server.listen(port, "0.0.0.0");
