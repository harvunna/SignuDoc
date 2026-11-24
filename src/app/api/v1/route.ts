// Interactive API reference (Swagger UI) at /api/v1.
//
// Swagger UI's files are served from this site (public/swagger-ui), because
// the Content-Security-Policy in src/proxy.ts only allows scripts from
// 'self'. The page reads the OpenAPI description at /api/v1/openapi.json,
// so it always matches the API this install runs.
//
// Swagger UI is Apache-2.0 licensed; see public/swagger-ui/LICENSE.

export const dynamic = "force-static";

const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Signly API v1 - Reference</title>
    <link rel="stylesheet" href="/swagger-ui/swagger-ui.css" />
    <style>
      body { margin: 0; background: #fafafa; }
      .topbar { display: none; }
      .signly-header {
        font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
        background: #4f46e5; color: #fff; padding: 14px 24px;
        font-size: 18px; font-weight: 600;
      }
      .signly-header span { font-weight: 400; opacity: 0.85; font-size: 14px; margin-left: 8px; }
    </style>
  </head>
  <body>
    <div class="signly-header">Signly API <span>v1 &middot; Authorize with your sdk_ API key</span></div>
    <div id="swagger-ui"></div>
    <script src="/swagger-ui/swagger-ui-bundle.js"></script>
    <script>
      window.addEventListener("load", function () {
        window.ui = SwaggerUIBundle({
          url: "/api/v1/openapi.json",
          dom_id: "#swagger-ui",
          deepLinking: true,
          persistAuthorization: false,
          tryItOutEnabled: false,
          docExpansion: "list",
          defaultModelsExpandDepth: 0,
          // Send "Try it out" calls to the site this page is open on, not
          // the server named in the description (the public address on
          // production, the branch address on a preview). On another
          // address of the same deployment the call would otherwise go
          // cross-site and come back 401 or blocked.
          requestInterceptor: function (request) {
            try {
              var target = new URL(request.url, window.location.href);
              if (target.pathname.indexOf("/api/v1") === 0) {
                request.url =
                  window.location.origin + target.pathname + target.search;
              }
            } catch (error) {}
            return request;
          },
        });
      });
    </script>
  </body>
</html>`;

export function GET() {
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=300",
    },
  });
}
