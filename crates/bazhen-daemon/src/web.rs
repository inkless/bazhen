//! The built web client (`http/web.ts`), for every GET or HEAD that reached no API route. A path
//! that names no file loads the app, so a reload on any of its views works; a missing asset is a
//! 404, never the app served as a script. The bundle is read on each request, so a rebuild needs
//! no restart, and a daemon started before the first build serves it once it exists.
//!
//! The path is read as it was sent. The TypeScript daemon's router decodes escapes, and the URL
//! parser in front of it drops `.` and `..` segments; a browser sends neither for the bundle's
//! files, and here a segment that still carries one names no file.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::extract::Request;
use axum::http::{Method, StatusCode, header};
use axum::response::{IntoResponse, Response};
use bazhen_protocol::nullable::Nullable;

/// What the page answers when there is no bundle to serve.
pub(crate) const NOT_BUILT: &str = "The web app isn't built. Run `moon run :build`, then reload.";

/// Vite names these by their content, so a new build never reuses a name.
const ASSETS: &str = "/assets/";

/// On every page response: no sniffing a type, no referrer, and no framing by another site.
const HEADERS: [(&str, &str); 3] = [
    ("x-content-type-options", "nosniff"),
    ("referrer-policy", "no-referrer"),
    ("content-security-policy", "frame-ancestors 'none'"),
];

/// Where `moon run :build` leaves the web client: `apps/web/dist` in the checkout whose
/// `target/<profile>` this binary runs from. A binary run from anywhere else names whatever is
/// three directories up from it, where there is normally no build, so the page says to make one.
pub(crate) fn bundle(exe: &Path) -> PathBuf {
    exe.ancestors()
        .nth(3)
        .unwrap_or_else(|| Path::new("/"))
        .join("apps/web/dist")
}

/// The bundle as doctor names it: its place once it's built, and null before.
pub(crate) fn app(root: &Path) -> Nullable<String> {
    if built(root) {
        Nullable::Value(root.to_string_lossy().into_owned())
    } else {
        Nullable::Null
    }
}

/// The page at the request's path, from the bundle at `root`.
pub(crate) async fn page(root: Arc<Path>, request: Request) -> Response {
    if !matches!(*request.method(), Method::GET | Method::HEAD) {
        return crate::routes::not_found().await;
    }
    let path = request.uri().path().to_owned();
    match tokio::task::spawn_blocking(move || look(&root, &path)).await {
        Ok(Page::File { body, kind, asset }) => {
            let cache = if asset {
                "public, max-age=31536000, immutable"
            } else {
                "no-cache"
            };
            (
                HEADERS,
                [(header::CONTENT_TYPE, kind), (header::CACHE_CONTROL, cache)],
                body,
            )
                .into_response()
        }
        Ok(Page::Missing) => crate::routes::not_found().await,
        Ok(Page::NotBuilt) => (
            StatusCode::NOT_FOUND,
            HEADERS,
            [(header::CONTENT_TYPE, "text/plain; charset=UTF-8")],
            NOT_BUILT,
        )
            .into_response(),
        Err(err) => crate::routes::internal(&err),
    }
}

/// What the bundle has for a path.
#[derive(Debug, PartialEq, Eq)]
enum Page {
    File {
        body: Vec<u8>,
        kind: &'static str,
        asset: bool,
    },
    /// The bundle is built, but has nothing at the path.
    Missing,
    NotBuilt,
}

fn look(root: &Path, path: &str) -> Page {
    let asset = path.starts_with(ASSETS);
    // A path naming a file that isn't there is a 404; only a view's path loads the app.
    let view = !asset && !path.rsplit('/').next().unwrap_or(path).contains('.');
    let file = bundled(root, path).or_else(|| {
        if view {
            bundled(root, "/index.html")
        } else {
            None
        }
    });
    match file {
        Some((file, body)) => Page::File {
            body,
            kind: content_type(&file),
            asset,
        },
        None if built(root) => Page::Missing,
        None => Page::NotBuilt,
    }
}

/// Whether `root` holds a bundle the page can serve.
pub(crate) fn built(root: &Path) -> bool {
    bundled(root, "/index.html").is_some()
}

/// A path segment that can name only a file inside the directory it is in. A NUL can't reach a
/// file at all: the kernel is never asked for a path holding one.
fn plain(segment: &str) -> bool {
    !segment.is_empty() && !segment.starts_with('.') && !segment.contains(['\\', '%'])
}

/// The bundle's file at `path`, where it really is, and what it holds. Only a plain file inside
/// the bundle counts: no dotfile, no empty, `.` or `..` segment, no escape left encoded, and
/// nothing a symlink leads out to.
fn bundled(root: &Path, path: &str) -> Option<(PathBuf, Vec<u8>)> {
    let segments: Vec<&str> = path.split('/').skip(1).collect();
    if !segments.iter().all(|segment| plain(segment)) {
        return None;
    }
    let base = std::fs::canonicalize(root).ok()?;
    let file = std::fs::canonicalize(base.join(segments.join("/"))).ok()?;
    let inside = file
        .strip_prefix(&base)
        .is_ok_and(|rest| !rest.as_os_str().is_empty());
    if !inside || !std::fs::metadata(&file).ok()?.is_file() {
        return None;
    }
    // Read here too: a rebuild empties the bundle, and a file gone since is simply not found.
    let body = std::fs::read(&file).ok()?;
    Some((file, body))
}

/// A file's type by its extension, from Hono's table, as the TypeScript daemon types it.
fn content_type(file: &Path) -> &'static str {
    let name = file.to_string_lossy();
    name.rsplit_once('.')
        .map(|(_, ext)| ext)
        .filter(|ext| !ext.is_empty() && ext.bytes().all(|b| b.is_ascii_alphanumeric()))
        .and_then(|ext| {
            let ext = ext.to_ascii_lowercase();
            MIMES.iter().find(|(e, _)| *e == ext).map(|(_, kind)| *kind)
        })
        .unwrap_or("application/octet-stream")
}

/// `hono/utils/mime`'s `baseMimes`.
const MIMES: &[(&str, &str)] = &[
    ("aac", "audio/aac"),
    ("avi", "video/x-msvideo"),
    ("avif", "image/avif"),
    ("av1", "video/av1"),
    ("bin", "application/octet-stream"),
    ("bmp", "image/bmp"),
    ("css", "text/css; charset=utf-8"),
    ("csv", "text/csv; charset=utf-8"),
    ("eot", "application/vnd.ms-fontobject"),
    ("epub", "application/epub+zip"),
    ("gif", "image/gif"),
    ("gz", "application/gzip"),
    ("htm", "text/html; charset=utf-8"),
    ("html", "text/html; charset=utf-8"),
    ("ico", "image/x-icon"),
    ("ics", "text/calendar; charset=utf-8"),
    ("jpeg", "image/jpeg"),
    ("jpg", "image/jpeg"),
    ("js", "text/javascript; charset=utf-8"),
    ("json", "application/json"),
    ("jsonld", "application/ld+json"),
    ("map", "application/json"),
    ("mid", "audio/x-midi"),
    ("midi", "audio/x-midi"),
    ("mjs", "text/javascript; charset=utf-8"),
    ("mp3", "audio/mpeg"),
    ("mp4", "video/mp4"),
    ("mpeg", "video/mpeg"),
    ("oga", "audio/ogg"),
    ("ogv", "video/ogg"),
    ("ogx", "application/ogg"),
    ("opus", "audio/opus"),
    ("otf", "font/otf"),
    ("pdf", "application/pdf"),
    ("png", "image/png"),
    ("rtf", "application/rtf"),
    ("svg", "image/svg+xml; charset=utf-8"),
    ("tif", "image/tiff"),
    ("tiff", "image/tiff"),
    ("ts", "video/mp2t"),
    ("ttf", "font/ttf"),
    ("txt", "text/plain; charset=utf-8"),
    ("wasm", "application/wasm"),
    ("webm", "video/webm"),
    ("weba", "audio/webm"),
    ("webmanifest", "application/manifest+json"),
    ("webp", "image/webp"),
    ("woff", "font/woff"),
    ("woff2", "font/woff2"),
    ("xhtml", "application/xhtml+xml; charset=utf-8"),
    ("xml", "application/xml; charset=utf-8"),
    ("zip", "application/zip"),
    ("3gp", "video/3gpp"),
    ("3g2", "video/3gpp2"),
    ("gltf", "model/gltf+json"),
    ("glb", "model/gltf-binary"),
];

#[cfg(test)]
mod tests {
    use axum::Router;
    use axum::body::Body;
    use proptest::prelude::*;
    use tower::ServiceExt;

    use super::*;
    use crate::guard;
    use crate::routes::{Gate, Shared, Stop, http_router};
    use crate::testing::TempDir;
    use crate::writer::Writer;

    const HOST: &str = "127.0.0.1:7900";
    const INDEX: &str = "<!doctype html><title>Bazhen</title>";
    const SCRIPT: &str = "console.log('app')";

    /// A built bundle as Vite lays one out, with a secret beside it that it must never serve.
    fn bundle(dir: &TempDir) -> PathBuf {
        let root = dir.path().join("dist");
        std::fs::create_dir_all(root.join("assets")).unwrap();
        std::fs::write(root.join("index.html"), INDEX).unwrap();
        std::fs::write(root.join("assets/index-abc123.js"), SCRIPT).unwrap();
        std::fs::write(root.join(".env"), "SECRET=1").unwrap();
        std::fs::write(dir.path().join("secret.txt"), "SECRET=1").unwrap();
        std::os::unix::fs::symlink(dir.path().join("secret.txt"), root.join("linked.txt")).unwrap();
        // Names a still-encoded or Windows-style path would land on, were it read literally.
        std::fs::write(root.join("assets/up%2fsecret.txt"), "SECRET=1").unwrap();
        std::fs::write(root.join("assets/up\\secret.txt"), "SECRET=1").unwrap();
        root
    }

    /// The daemon's loopback HTTP routes over the bundle at `root`, with no browser paired.
    fn daemon(root: &Path, pairing_required: bool) -> Router {
        let shared =
            Shared::new("f".repeat(64).as_str(), Stop::default(), Writer::closed()).with_web(root);
        let gate = Gate {
            allow: guard::allowlists(7900, None, &[]),
            pairing_required,
        };
        http_router(shared, gate)
    }

    /// An answer's status, the headers asked for, and its body as text.
    #[derive(Debug, PartialEq, Eq)]
    struct Answer {
        status: u16,
        headers: Vec<Option<String>>,
        body: String,
    }

    fn ask(router: &Router, method: &str, path: &str, headers: &[(&str, &str)]) -> Answer {
        asking(router, method, path, headers, &[])
    }

    fn asking(
        router: &Router,
        method: &str,
        path: &str,
        headers: &[(&str, &str)],
        read: &[&str],
    ) -> Answer {
        let mut request = Request::builder().method(method).uri(path);
        // The daemon's own Host, unless the test names another in its place.
        if !headers
            .iter()
            .any(|(name, _)| name.eq_ignore_ascii_case("host"))
        {
            request = request.header("host", HOST);
        }
        for (name, value) in headers {
            request = request.header(*name, *value);
        }
        let request = request.body(Body::empty()).unwrap();
        crate::testing::runtime().block_on(async {
            let response = router.clone().oneshot(request).await.unwrap();
            let headers = read
                .iter()
                .map(|name| {
                    response
                        .headers()
                        .get(*name)
                        .map(|v| v.to_str().unwrap().to_owned())
                })
                .collect();
            let status = response.status().as_u16();
            let body = axum::body::to_bytes(response.into_body(), 1 << 20)
                .await
                .unwrap();
            Answer {
                status,
                headers,
                body: String::from_utf8_lossy(&body).into_owned(),
            }
        })
    }

    fn unbuilt(dir: &TempDir) -> PathBuf {
        dir.path().join("dist")
    }

    #[test]
    fn serves_the_app_to_a_browser_that_hasnt_paired_and_still_asks_it_to_pair_for_the_api() {
        let dir = TempDir::new("web");
        let router = daemon(&bundle(&dir), true);
        let forwarded = [("x-forwarded-for", "192.168.1.30, 127.0.0.1")];
        let page = ask(&router, "GET", "/", &forwarded);
        let api = ask(&router, "GET", "/v1/health", &forwarded);
        assert_eq!(
            (page.status, page.body.as_str(), api.status),
            (200, INDEX, 401)
        );
    }

    #[test]
    fn loads_the_app_on_a_path_that_names_no_file_so_a_reload_on_any_view_works() {
        let dir = TempDir::new("web");
        let router = daemon(&bundle(&dir), true);
        assert_eq!(
            asking(&router, "GET", "/agents/agent_1", &[], &["content-type"]),
            Answer {
                status: 200,
                headers: vec![Some("text/html; charset=utf-8".to_owned())],
                body: INDEX.to_owned(),
            }
        );
    }

    #[test]
    fn caches_hashed_assets_for_good_and_the_apps_page_not_at_all() {
        let dir = TempDir::new("web");
        let router = daemon(&bundle(&dir), true);
        let read = ["cache-control", "content-type"];
        let asset = asking(&router, "GET", "/assets/index-abc123.js", &[], &read);
        let page = asking(&router, "GET", "/", &[], &read);
        assert_eq!(
            (asset.body.as_str(), asset.headers, page.headers),
            (
                SCRIPT,
                vec![
                    Some("public, max-age=31536000, immutable".to_owned()),
                    Some("text/javascript; charset=utf-8".to_owned()),
                ],
                vec![
                    Some("no-cache".to_owned()),
                    Some("text/html; charset=utf-8".to_owned()),
                ],
            )
        );
    }

    #[test]
    fn answers_a_missing_file_404_rather_than_serving_the_apps_page_in_its_place() {
        let dir = TempDir::new("web");
        let router = daemon(&bundle(&dir), true);
        let statuses = ["/assets/index-gone.js", "/favicon.ico", "/assets/view"]
            .map(|path| ask(&router, "GET", path, &[]).status);
        assert_eq!(statuses, [404; 3]);
    }

    #[test]
    fn forbids_framing_and_type_sniffing_on_what_it_serves_built_or_not() {
        let (dir, empty) = (TempDir::new("web"), TempDir::new("web-unbuilt"));
        let (router, unbuilt) = (daemon(&bundle(&dir), true), daemon(&unbuilt(&empty), true));
        let read = [
            "content-security-policy",
            "x-content-type-options",
            "referrer-policy",
        ];
        let headers = [
            asking(&router, "GET", "/", &[], &read).headers,
            asking(&router, "GET", "/assets/index-abc123.js", &[], &read).headers,
            asking(&unbuilt, "GET", "/", &[], &read).headers,
        ];
        let expected =
            ["frame-ancestors 'none'", "nosniff", "no-referrer"].map(|v| Some(v.to_owned()));
        assert_eq!(
            headers,
            [expected.to_vec(), expected.to_vec(), expected.to_vec()]
        );
    }

    #[test]
    fn serves_no_dotfile_and_nothing_a_symlink_leads_out_of_the_bundle_to() {
        let dir = TempDir::new("web");
        let router = daemon(&bundle(&dir), true);
        let answers = ["/.env", "/linked.txt"].map(|path| ask(&router, "GET", path, &[]));
        assert_eq!(
            answers.map(|a| (a.status, a.body.contains("SECRET"))),
            [(404, false); 2]
        );
    }

    #[test]
    fn finds_no_file_by_a_name_that_still_carries_an_escape_or_a_backslash() {
        let dir = TempDir::new("web");
        let root = bundle(&dir);
        let found =
            ["/assets/up%2fsecret.txt", "/assets/up\\secret.txt"].map(|path| bundled(&root, path));
        assert_eq!(found, [None, None]);
    }

    #[test]
    fn finds_no_file_for_a_path_that_climbs_out_of_the_bundle_however_it_is_spelled() {
        let dir = TempDir::new("web");
        let root = bundle(&dir);
        let paths = [
            "/../secret.txt",
            "/assets/../../secret.txt",
            "/%2e%2e/secret.txt",
            "/assets/..%2f..%2fsecret.txt",
            "/assets\\..\\..\\secret.txt",
            "/./index.html",
            "//index.html",
        ];
        let found = paths.map(|path| bundled(&root, path).is_some());
        assert_eq!(found, [false; 7]);
        // And what the same root does serve, so it is the spelling that finds nothing.
        assert!(bundled(&root, "/index.html").is_some());
    }

    /// A request's path is read as it was sent, escapes and dot segments too, where Hono decodes
    /// them: whatever its spelling, it reaches nothing outside the bundle, not even through a
    /// symlink to a directory beside it.
    #[test]
    fn serves_nothing_from_outside_the_bundle_by_any_spelling_of_a_climb() {
        let dir = TempDir::new("web");
        let root = bundle(&dir);
        std::os::unix::fs::symlink(dir.path(), root.join("out")).unwrap();
        let router = daemon(&root, true);
        let paths = [
            "/../secret.txt",
            "/assets/../../secret.txt",
            "/%2e%2e/secret.txt",
            "/%2E%2E/secret.txt",
            "/assets/%2e%2e/%2e%2e/secret.txt",
            "/assets/..%2f..%2fsecret.txt",
            "/./../secret.txt",
            "/out/secret.txt",
            "/out/secret",
            "/linked.txt",
        ];
        let leaked = paths.map(|path| ask(&router, "GET", path, &[]).body.contains("SECRET"));
        assert_eq!(leaked, [false; 10]);
        // What the symlink leads to is there, so it is the bundle's bounds that keep it out.
        assert!(
            std::fs::read_to_string(root.join("out/secret.txt"))
                .unwrap()
                .contains("SECRET")
        );
    }

    /// The segments a path is drawn from: the bundle's own names, the names beside it and the
    /// links out of it, every spelling of a climb, and anything at all, up to past a name's limit.
    fn segment() -> impl Strategy<Value = String> {
        let known = prop::sample::select(vec![
            "",
            ".",
            "..",
            "...",
            "%2e%2e",
            "%2E%2e",
            "..%2f..",
            "..\\..",
            "\\",
            "%",
            "%00",
            "index.html",
            "assets",
            "index-abc123.js",
            ".env",
            "linked.txt",
            "out",
            "secret.txt",
            "up%2fsecret.txt",
            "up\\secret.txt",
            "dist",
            "é",
            "\u{202e}",
            "\u{fffd}",
            // Whole climbs, so a path reaches past the bundle often enough to be checked.
            "../secret.txt",
            "assets/../../secret.txt",
            "out/secret.txt",
            "out/dist/index.html",
        ])
        .prop_map(str::to_owned);
        prop_oneof![
            6 => known,
            1 => any::<String>(),
            1 => "[./%a-z0-9\\\\]{1,8}",
            1 => "[a-z]{200,600}",
        ]
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(1024))]

        /// Whatever path a request carries, what it finds is a file inside the bundle, where it
        /// really is: never the bundle itself, nothing beside it, and nothing a link leads out to.
        #[test]
        fn any_path_finds_a_file_inside_the_bundle_or_nothing(
            segments in prop::collection::vec(segment(), 1..5),
        ) {
            let dir = TempDir::new("web-any");
            let root = bundle(&dir);
            std::os::unix::fs::symlink(dir.path(), root.join("out")).unwrap();
            // A request's path always starts at the root.
            let path = format!("/{}", segments.join("/"));
            if let Some((file, body)) = bundled(&root, &path) {
                let base = std::fs::canonicalize(&root).unwrap();
                prop_assert!(file.starts_with(&base) && file != base, "{path:?} found {file:?}");
                prop_assert_eq!(std::fs::canonicalize(&file).unwrap(), file.clone());
                prop_assert!(std::fs::metadata(&file).unwrap().is_file());
                prop_assert!(!String::from_utf8_lossy(&body).contains("SECRET"), "{path:?}");
            }
        }
    }

    #[test]
    fn puts_every_spelling_of_an_api_path_behind_pairing_or_reaches_no_api_route() {
        let dir = TempDir::new("web");
        let root = bundle(&dir);
        let router = daemon(&root, true);
        let spellings = [
            "/v1",
            "/v1/health",
            "//v1/health",
            "/v1//health",
            "/v1/./health",
            "/%76%31/health",
            "/V1/health",
            "/v1%2Fhealth",
        ];
        let answered =
            spellings.map(|path| ask(&router, "GET", path, &[]).body.contains("protocolId"));
        assert_eq!(answered, [false; 8]);
        // Where pairing isn't asked, the API does answer: it is the gate that held it back.
        assert!(
            ask(&daemon(&root, false), "GET", "/v1/health", &[])
                .body
                .contains("protocolId")
        );
    }

    #[test]
    fn keeps_an_unknown_api_path_an_api_404_never_the_apps_page() {
        let dir = TempDir::new("web");
        let router = daemon(&bundle(&dir), false);
        let answer = ask(&router, "GET", "/v1/nothing", &[]);
        assert_eq!((answer.status, answer.body.contains(INDEX)), (404, false));
    }

    #[test]
    fn answers_only_get_and_head_off_the_api() {
        let dir = TempDir::new("web");
        let router = daemon(&bundle(&dir), true);
        let origin = [("origin", "http://127.0.0.1:7900")];
        let statuses = ["HEAD", "POST", "PUT", "DELETE"]
            .map(|method| ask(&router, method, "/", &origin).status);
        assert_eq!(statuses, [200, 404, 404, 404]);
    }

    #[test]
    fn refuses_the_page_to_a_host_it_doesnt_admit_as_it_refuses_the_api() {
        let dir = TempDir::new("web");
        let router = daemon(&bundle(&dir), true);
        let answer = ask(&router, "GET", "/", &[("host", "evil.example:7900")]);
        assert_eq!((answer.status, answer.body.contains(INDEX)), (421, false));
    }

    #[test]
    fn looks_for_the_bundle_where_the_web_clients_build_leaves_it() {
        let checkout = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        let built = super::bundle(&checkout.join("target/release/bazhen-daemon"));
        // Its parent, not `dist/..`, which the kernel resolves only once `dist` exists.
        let web = built.parent().unwrap();
        assert_eq!(
            [
                web.join("vite.config.ts").exists(),
                web.join("index.html").exists(),
                built.ends_with("apps/web/dist"),
            ],
            [true; 3]
        );
        assert_eq!(
            super::bundle(Path::new("/repo/target/debug/bazhen-daemon")),
            Path::new("/repo/apps/web/dist")
        );
    }

    #[test]
    fn says_to_build_the_app_when_there_is_no_bundle_and_serves_the_api_regardless() {
        let empty = TempDir::new("web-unbuilt");
        let router = daemon(&unbuilt(&empty), true);
        let page = ask(&router, "GET", "/", &[]);
        let pairing = ask(&router, "POST", "/v1/pairing", &[]);
        assert_eq!(
            (page.status, page.body.as_str(), pairing.status),
            (404, NOT_BUILT, 403)
        );
    }

    #[test]
    fn names_the_bundle_to_doctor_once_it_is_built_and_null_before() {
        let (dir, empty) = (TempDir::new("web"), TempDir::new("web-unbuilt"));
        let root = bundle(&dir);
        assert_eq!(
            [app(&root), app(&unbuilt(&empty))],
            [
                Nullable::Value(root.to_string_lossy().into_owned()),
                Nullable::Null
            ]
        );
    }

    #[test]
    fn types_a_file_by_its_extension_as_hono_does() {
        let types = [
            "/b/index.html",
            "/b/assets/a.CSS",
            "/b/assets/font.woff2",
            "/b/assets/a.map",
            "/b/x.unknown",
            "/b/no-extension",
            "/b.d/plain",
            "/b/x.d-ts",
        ]
        .map(|path| content_type(Path::new(path)));
        assert_eq!(
            types,
            [
                "text/html; charset=utf-8",
                "text/css; charset=utf-8",
                "font/woff2",
                "application/json",
                "application/octet-stream",
                "application/octet-stream",
                "application/octet-stream",
                "application/octet-stream",
            ]
        );
    }
}
