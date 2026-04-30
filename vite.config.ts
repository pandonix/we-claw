import { defineConfig, type Plugin } from "vite";
import { createBootstrapSnapshot, createLauncherContext } from "./src/launcher/bootstrap";
import { installGatewayBridge } from "./src/launcher/gateway-bridge";

function bootstrapApiPlugin(): Plugin {
  const context = createLauncherContext({ manageGateway: false });

  return {
    name: "we-claw-bootstrap-api",
    configureServer(server) {
      if (server.httpServer) installGatewayBridge(server.httpServer, context);
      server.middlewares.use(async (request, response, next) => {
        if (!request.url?.startsWith("/api/bootstrap") && !request.url?.startsWith("/api/gateway/status")) {
          next();
          return;
        }

        const body = await createBootstrapSnapshot(context);
        response.statusCode = 200;
        response.setHeader("content-type", "application/json; charset=utf-8");
        response.end(JSON.stringify(body));
      });
    }
  };
}

export default defineConfig({
  plugins: [bootstrapApiPlugin()],
  server: {
    host: "127.0.0.1",
    port: 5173
  },
  build: {
    outDir: "dist/client",
    emptyOutDir: true
  }
});
