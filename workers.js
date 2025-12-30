export default {
  async fetch(request, env, ctx) {
    const { method } = request;
    const url = new URL(request.url);

    // ============================================
    // SETTING LOGIN - TUKAR SINI
    // ============================================
    const USERNAME = "USERNAME";
    const PASSWORD = "PASSWORD";
    // ============================================

    const authResult = checkAuth(request, USERNAME, PASSWORD);
    
    // Login Page
    if (url.pathname === "/login") {
      if (method === "GET") {
        return new Response(getLoginHTML(), { headers: { "Content-Type": "text/html" } });
      }
      if (method === "POST") {
        const formData = await request.formData();
        const loginType = formData.get("login_type");
        
        if (loginType === "guest") {
          return new Response(null, {
            status: 302,
            headers: {
              "Location": "/",
              "Set-Cookie": "auth=guest; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400",
            },
          });
        }
        
        const username = formData.get("username");
        const password = formData.get("password");
        
        if (username === USERNAME && password === PASSWORD) {
          const token = btoa(`${username}:${password}`);
          return new Response(null, {
            status: 302,
            headers: {
              "Location": "/",
              "Set-Cookie": `auth=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`,
            },
          });
        } else {
          return new Response(getLoginHTML("Username atau password salah!"), {
            headers: { "Content-Type": "text/html" },
            status: 401,
          });
        }
      }
    }

    // Logout
    if (url.pathname === "/logout") {
      return new Response(null, {
        status: 302,
        headers: {
          "Location": "/login",
          "Set-Cookie": "auth=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0",
        },
      });
    }

    // Protect routes
    if (!authResult.authenticated) {
      return Response.redirect(new URL("/login", url.origin).toString(), 302);
    }

    const isGuest = authResult.role === "guest";

    // Main UI
    if (method === "GET" && url.pathname === "/") {
      return new Response(getMainHTML(authResult.username, isGuest), {
        headers: { "Content-Type": "text/html" },
      });
    }

    // Upload (Admin only)
    if (method === "POST" && url.pathname === "/upload") {
      if (isGuest) return Response.json({ error: "Unauthorized" }, { status: 403 });
      try {
        const formData = await request.formData();
        const file = formData.get("file");
        const folder = formData.get("folder") || "";
        if (!file || typeof file === "string") {
          return Response.json({ error: "No file" }, { status: 400 });
        }
        const key = folder ? `${folder}/${file.name}` : file.name;
        await env.FILES_BUCKET.put(key, file.stream(), {
          httpMetadata: { contentType: file.type },
        });
        return Response.json({ success: true, key });
      } catch (e) {
        return Response.json({ error: e.message }, { status: 500 });
      }
    }

    // Create Folder (Admin only)
    if (method === "POST" && url.pathname === "/folder") {
      if (isGuest) return Response.json({ error: "Unauthorized" }, { status: 403 });
      try {
        const { name, parent } = await request.json();
        const key = parent ? `${parent}/${name}/.keep` : `${name}/.keep`;
        await env.FILES_BUCKET.put(key, "");
        return Response.json({ success: true });
      } catch (e) {
        return Response.json({ error: e.message }, { status: 500 });
      }
    }

    // Delete (Admin only)
    if (method === "DELETE") {
      if (isGuest) return Response.json({ error: "Unauthorized" }, { status: 403 });
      try {
        const { keys } = await request.json();
        for (const key of keys) {
          if (key.endsWith("/")) {
            const list = await env.FILES_BUCKET.list({ prefix: key });
            for (const obj of list.objects) {
              await env.FILES_BUCKET.delete(obj.key);
            }
          } else {
            await env.FILES_BUCKET.delete(key);
          }
        }
        return Response.json({ success: true });
      } catch (e) {
        return Response.json({ error: e.message }, { status: 500 });
      }
    }

    // Toggle Public (Admin only)
    if (method === "POST" && url.pathname === "/toggle-public") {
      if (isGuest) return Response.json({ error: "Unauthorized" }, { status: 403 });
      try {
        const { key, isPublic } = await request.json();
        let publicFiles = await getPublicFiles(env);
        if (isPublic) {
          if (!publicFiles.includes(key)) publicFiles.push(key);
        } else {
          publicFiles = publicFiles.filter(f => f !== key);
        }
        await env.FILES_BUCKET.put(".public-files.json", JSON.stringify(publicFiles), {
          httpMetadata: { contentType: "application/json" },
        });
        return Response.json({ success: true });
      } catch (e) {
        return Response.json({ error: e.message }, { status: 500 });
      }
    }

    // Get Public Files List
    if (method === "GET" && url.pathname === "/public-files") {
      return Response.json(await getPublicFiles(env));
    }

    // Download/Preview File
    if (method === "GET" && url.pathname.startsWith("/files/")) {
      const key = decodeURIComponent(url.pathname.replace("/files/", ""));
      if (isGuest) {
        const publicFiles = await getPublicFiles(env);
        if (!publicFiles.includes(key)) {
          return new Response("File is private", { status: 403 });
        }
      }
      const object = await env.FILES_BUCKET.get(key);
      if (!object) return new Response("Not Found", { status: 404 });
      const headers = new Headers();
      headers.set("Content-Type", object.httpMetadata?.contentType || "application/octet-stream");
      if (url.searchParams.get("download") === "true") {
        headers.set("Content-Disposition", `attachment; filename="${key.split("/").pop()}"`);
      }
      return new Response(object.body, { headers });
    }

    // List Files
    if (method === "GET" && url.pathname === "/list") {
      const prefix = url.searchParams.get("prefix") || "";
      const list = await env.FILES_BUCKET.list({ prefix, delimiter: "/" });
      const publicFiles = await getPublicFiles(env);
      
      let folders = (list.delimitedPrefixes || []).map(p => ({
        name: p.replace(prefix, "").replace("/", ""),
        key: p,
        type: "folder",
      }));

      let files = list.objects
        .filter(obj => !obj.key.endsWith("/.keep") && !obj.key.startsWith("."))
        .map(obj => ({
          name: obj.key.replace(prefix, ""),
          key: obj.key,
          size: obj.size,
          uploaded: obj.uploaded,
          type: "file",
          isPublic: publicFiles.includes(obj.key),
        }));

      if (isGuest) {
        files = files.filter(f => f.isPublic);
        folders = folders.filter(folder => publicFiles.some(pf => pf.startsWith(folder.key)));
      }

      return Response.json({ folders, files, prefix });
    }

    // Stats
    if (method === "GET" && url.pathname === "/stats") {
      const list = await env.FILES_BUCKET.list();
      const publicFiles = await getPublicFiles(env);
      let objects = list.objects.filter(o => !o.key.endsWith("/.keep") && !o.key.startsWith("."));
      if (isGuest) objects = objects.filter(o => publicFiles.includes(o.key));
      const totalSize = objects.reduce((sum, obj) => sum + obj.size, 0);
      return Response.json({ totalSize, totalFiles: objects.length });
    }

    // Get Notes
    if (method === "GET" && url.pathname === "/notes") {
      try {
        const object = await env.FILES_BUCKET.get(".notes.json");
        if (!object) return Response.json([]);
        return Response.json(JSON.parse(await object.text()));
      } catch (e) {
        return Response.json([]);
      }
    }

    // Save Notes (Admin only)
    if (method === "POST" && url.pathname === "/notes") {
      if (isGuest) return Response.json({ error: "Guests cannot send notes" }, { status: 403 });
      try {
        const notes = await request.json();
        await env.FILES_BUCKET.put(".notes.json", JSON.stringify(notes), {
          httpMetadata: { contentType: "application/json" },
        });
        return Response.json({ success: true });
      } catch (e) {
        return Response.json({ error: e.message }, { status: 500 });
      }
    }

    return new Response("404 Not Found", { status: 404 });
  },
};

async function getPublicFiles(env) {
  try {
    const object = await env.FILES_BUCKET.get(".public-files.json");
    if (!object) return [];
    return JSON.parse(await object.text());
  } catch (e) {
    return [];
  }
}

function checkAuth(request, username, password) {
  const cookie = request.headers.get("Cookie") || "";
  const match = cookie.match(/auth=([^;]+)/);
  if (match) {
    if (match[1] === "guest") {
      return { authenticated: true, username: "Guest", role: "guest" };
    }
    try {
      const decoded = atob(match[1]);
      const [u, p] = decoded.split(":");
      if (u === username && p === password) {
        return { authenticated: true, username: u, role: "admin" };
      }
    } catch (e) {}
  }
  return { authenticated: false };
}

function getLoginHTML(error = "") {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Login - Cloud Storage</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
  <link href="https://fonts.googleapis.com/icon?family=Material+Icons+Outlined" rel="stylesheet">
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{font-family:'Inter',sans-serif;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
    .login-box{background:#fff;border-radius:16px;box-shadow:0 20px 60px rgba(0,0,0,0.3);width:100%;max-width:400px;padding:40px}
    .logo{display:flex;align-items:center;justify-content:center;gap:12px;margin-bottom:24px}
    .logo-icon{width:50px;height:50px;background:linear-gradient(135deg,#4285f4,#34a853,#fbbc04,#ea4335);border-radius:12px;display:flex;align-items:center;justify-content:center;color:#fff}
    .logo-icon .material-icons-outlined{font-size:28px}
    .logo-text{font-size:22px;font-weight:600;color:#202124}
    h1{text-align:center;font-size:20px;color:#202124;margin-bottom:8px}
    .subtitle{text-align:center;font-size:14px;color:#5f6368;margin-bottom:24px}
    .error{background:#fce8e6;color:#c5221f;padding:12px;border-radius:8px;margin-bottom:16px;font-size:14px;display:flex;align-items:center;gap:8px}
    .form-group{margin-bottom:16px}
    label{display:block;font-size:14px;font-weight:500;color:#202124;margin-bottom:6px}
    input{width:100%;padding:12px;border:2px solid #e0e0e0;border-radius:8px;font-size:14px;outline:none;transition:border-color 0.2s}
    input:focus{border-color:#1a73e8}
    .btn{width:100%;padding:12px;border:none;border-radius:8px;font-size:14px;font-weight:500;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:8px;transition:all 0.2s}
    .btn-primary{background:#1a73e8;color:#fff}
    .btn-primary:hover{background:#1557b0}
    .btn-guest{background:#fff;color:#5f6368;border:2px solid #e0e0e0;margin-top:12px}
    .btn-guest:hover{background:#f8f9fa}
    .divider{display:flex;align-items:center;margin:20px 0;color:#5f6368;font-size:14px}
    .divider::before,.divider::after{content:'';flex:1;height:1px;background:#e0e0e0}
    .divider span{padding:0 16px}
    .guest-info{background:#e8f0fe;border-radius:8px;padding:12px;margin-top:16px;font-size:12px;color:#1967d2}
    .guest-info ul{margin:8px 0 0 16px}
    .guest-info li{margin:4px 0}
  </style>
</head>
<body>
  <div class="login-box">
    <div class="logo">
      <div class="logo-icon"><span class="material-icons-outlined">cloud</span></div>
      <span class="logo-text">Cloud Storage</span>
    </div>
    <h1>Welcome</h1>
    <p class="subtitle">Sign in to access files</p>
    ${error ? `<div class="error"><span class="material-icons-outlined">error</span>${error}</div>` : ''}
    <form method="POST" action="/login">
      <input type="hidden" name="login_type" value="admin">
      <div class="form-group">
        <label>Username</label>
        <input type="text" name="username" placeholder="Enter username" required>
      </div>
      <div class="form-group">
        <label>Password</label>
        <input type="password" name="password" placeholder="Enter password" required>
      </div>
      <button type="submit" class="btn btn-primary">
        <span class="material-icons-outlined">login</span>Sign In as Admin
      </button>
    </form>
    <div class="divider"><span>or</span></div>
    <form method="POST" action="/login">
      <input type="hidden" name="login_type" value="guest">
      <button type="submit" class="btn btn-guest">
        <span class="material-icons-outlined">visibility</span>Continue as Guest
      </button>
    </form>
    <div class="guest-info">
      <strong>Guest access:</strong>
      <ul>
        <li>View & download public files only</li>
        <li>Read notes (cannot send)</li>
        <li>No upload or delete</li>
      </ul>
    </div>
  </div>
</body>
</html>`;
}

function getMainHTML(username, isGuest) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Cloud Storage</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
  <link href="https://fonts.googleapis.com/icon?family=Material+Icons+Outlined" rel="stylesheet">
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    :root{--primary:#1a73e8;--bg:#f8fafc;--surface:#fff;--text:#202124;--text2:#5f6368;--border:#e0e0e0;--hover:#f1f3f4;--selected:#e8f0fe;--success:#34a853;--error:#ea4335;--warning:#fbbc04}
    body{font-family:'Inter',sans-serif;background:var(--bg);color:var(--text);min-height:100vh}
    .header{background:var(--surface);border-bottom:1px solid var(--border);padding:8px 16px;display:flex;align-items:center;gap:16px;position:sticky;top:0;z-index:100}
    .logo{display:flex;align-items:center;gap:8px;font-size:20px;font-weight:600;color:var(--text2)}
    .logo-icon{width:36px;height:36px;background:linear-gradient(135deg,#4285f4,#34a853,#fbbc04,#ea4335);border-radius:8px;display:flex;align-items:center;justify-content:center;color:#fff}
    .search-bar{flex:1;max-width:600px;margin:0 auto}
    .search-bar input{width:100%;padding:10px 16px;border:none;background:var(--hover);border-radius:8px;font-size:14px;outline:none}
    .search-bar input:focus{background:var(--surface);box-shadow:0 1px 3px rgba(0,0,0,0.1)}
    .guest-badge{background:var(--warning);color:#000;padding:4px 12px;border-radius:16px;font-size:12px;font-weight:500}
    .user-menu{display:flex;align-items:center;gap:8px;padding:8px 12px;border-radius:20px;cursor:pointer}
    .user-menu:hover{background:var(--hover)}
    .user-avatar{width:32px;height:32px;background:${isGuest ? 'var(--warning)' : 'var(--primary)'};border-radius:50%;display:flex;align-items:center;justify-content:center;color:${isGuest ? '#000' : '#fff'};font-size:14px;font-weight:500}
    .container{display:flex;min-height:calc(100vh - 57px)}
    .sidebar{width:240px;background:var(--surface);border-right:1px solid var(--border);padding:8px;flex-shrink:0}
    .new-btn{display:flex;align-items:center;gap:10px;padding:10px 20px;background:var(--surface);border:1px solid var(--border);border-radius:20px;font-size:14px;font-weight:500;cursor:pointer;margin-bottom:16px;width:fit-content}
    .new-btn:hover{box-shadow:0 1px 3px rgba(0,0,0,0.1)}
    .new-btn:disabled{opacity:0.5;cursor:not-allowed}
    .sidebar-item{display:flex;align-items:center;gap:12px;padding:8px 20px;border-radius:0 20px 20px 0;cursor:pointer;font-size:14px;color:var(--text);text-decoration:none}
    .sidebar-item:hover{background:var(--hover)}
    .sidebar-item.active{background:var(--selected);color:var(--primary);font-weight:500}
    .sidebar-item .material-icons-outlined{font-size:20px;color:var(--text2)}
    .sidebar-item.active .material-icons-outlined{color:var(--primary)}
    .sidebar-item.logout{color:var(--error)}
    .sidebar-item.logout .material-icons-outlined{color:var(--error)}
    .sidebar-divider{height:1px;background:var(--border);margin:8px 0}
    .storage-info{padding:16px 20px;border-top:1px solid var(--border);margin-top:16px}
    .storage-bar{height:4px;background:var(--hover);border-radius:2px;margin:8px 0}
    .storage-bar-fill{height:100%;background:var(--primary);border-radius:2px}
    .storage-text{font-size:12px;color:var(--text2)}
    .main{flex:1;padding:16px 24px;overflow-y:auto}
    .toolbar{display:flex;align-items:center;gap:8px;margin-bottom:16px;padding-bottom:16px;border-bottom:1px solid var(--border)}
    .breadcrumb{display:flex;align-items:center;gap:4px;flex:1}
    .breadcrumb-item{padding:6px 10px;border-radius:4px;cursor:pointer;font-size:14px;color:var(--text2)}
    .breadcrumb-item:hover{background:var(--hover)}
    .breadcrumb-item.active{color:var(--text);font-weight:500}
    .view-toggle{display:flex;border:1px solid var(--border);border-radius:4px;overflow:hidden}
    .view-toggle button{padding:6px 10px;border:none;background:var(--surface);cursor:pointer;color:var(--text2)}
    .view-toggle button:hover{background:var(--hover)}
    .view-toggle button.active{background:var(--selected);color:var(--primary)}
    .file-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:16px}
    .file-card{background:var(--surface);border:1px solid var(--border);border-radius:8px;overflow:hidden;cursor:pointer;position:relative}
    .file-card:hover{box-shadow:0 1px 3px rgba(0,0,0,0.1)}
    .file-card.selected{border-color:var(--primary);background:var(--selected)}
    .file-preview{height:120px;background:var(--hover);display:flex;align-items:center;justify-content:center;position:relative}
    .file-preview img{width:100%;height:100%;object-fit:cover}
    .file-preview .material-icons-outlined{font-size:48px;color:var(--text2)}
    .file-info{padding:10px}
    .file-name{font-size:13px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-bottom:4px}
    .file-meta{font-size:11px;color:var(--text2);display:flex;align-items:center;gap:6px}
    .public-badge{background:var(--success);color:#fff;padding:2px 6px;border-radius:8px;font-size:10px}
    .private-badge{background:var(--text2);color:#fff;padding:2px 6px;border-radius:8px;font-size:10px}
    .file-toggle{position:absolute;top:8px;right:8px;background:#fff;border:none;border-radius:50%;width:28px;height:28px;cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 4px rgba(0,0,0,0.2);opacity:0;transition:opacity 0.15s}
    .file-card:hover .file-toggle{opacity:1}
    .file-toggle.is-public{background:var(--success);color:#fff;opacity:1}
    .file-toggle .material-icons-outlined{font-size:16px}
    .file-list{display:none}
    .file-list.active{display:block}
    .file-grid.hidden{display:none}
    .file-row{display:grid;grid-template-columns:36px 1fr 70px 100px 120px 40px;align-items:center;padding:8px 12px;border-bottom:1px solid var(--border);cursor:pointer}
    .file-row:hover{background:var(--hover)}
    .file-row.selected{background:var(--selected)}
    .file-row-name{font-size:13px}
    .file-row-size,.file-row-date{font-size:12px;color:var(--text2)}
    .list-header{display:grid;grid-template-columns:36px 1fr 70px 100px 120px 40px;padding:8px 12px;font-size:12px;font-weight:500;color:var(--text2);border-bottom:1px solid var(--border)}
    .dropdown{position:fixed;background:var(--surface);border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,0.15);z-index:200;padding:8px 0;min-width:180px;display:none}
    .dropdown.show{display:block}
    .dropdown-item{display:flex;align-items:center;gap:10px;padding:8px 16px;font-size:13px;cursor:pointer}
    .dropdown-item:hover{background:var(--hover)}
    .dropdown-item .material-icons-outlined{font-size:18px;color:var(--text2)}
    .dropdown-divider{height:1px;background:var(--border);margin:4px 0}
    .modal-overlay{position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;z-index:300;opacity:0;visibility:hidden;transition:all 0.2s}
    .modal-overlay.show{opacity:1;visibility:visible}
    .modal{background:var(--surface);border-radius:12px;width:100%;max-width:360px;padding:24px}
    .modal-title{font-size:18px;font-weight:500;margin-bottom:16px}
    .modal-input{width:100%;padding:10px;border:1px solid var(--border);border-radius:6px;font-size:14px;outline:none;margin-bottom:16px}
    .modal-input:focus{border-color:var(--primary)}
    .modal-actions{display:flex;justify-content:flex-end;gap:8px}
    .btn{padding:8px 20px;border-radius:6px;font-size:14px;font-weight:500;cursor:pointer;border:none}
    .btn-text{background:transparent;color:var(--primary)}
    .btn-text:hover{background:var(--selected)}
    .btn-primary{background:var(--primary);color:#fff}
    .btn-danger{background:var(--error);color:#fff}
    .upload-progress{position:fixed;bottom:24px;right:24px;background:var(--surface);border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,0.15);padding:16px;width:280px;display:none}
    .upload-progress.show{display:block}
    .progress-bar{height:4px;background:var(--hover);border-radius:2px;margin-top:8px}
    .progress-fill{height:100%;background:var(--primary);border-radius:2px;transition:width 0.3s}
    .empty-state{text-align:center;padding:60px}
    .empty-state .material-icons-outlined{font-size:64px;color:var(--text2);margin-bottom:16px}
    .empty-state-title{font-size:20px;font-weight:500;margin-bottom:8px}
    .empty-state-text{font-size:14px;color:var(--text2)}
    .toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%) translateY(100px);background:#323232;color:#fff;padding:12px 24px;border-radius:6px;font-size:14px;z-index:400;transition:transform 0.3s}
    .toast.show{transform:translateX(-50%) translateY(0)}
    .selection-bar{position:fixed;bottom:24px;left:50%;transform:translateX(-50%) translateY(100px);background:var(--primary);color:#fff;padding:10px 20px;border-radius:8px;display:flex;align-items:center;gap:16px;z-index:150;transition:transform 0.3s}
    .selection-bar.show{transform:translateX(-50%) translateY(0)}
    .selection-bar button{background:transparent;border:none;color:#fff;cursor:pointer;padding:6px;border-radius:4px;display:flex;align-items:center;gap:6px;font-size:13px}
    .selection-bar button:hover{background:rgba(255,255,255,0.1)}
    .preview-modal{position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.9);z-index:400;display:none;align-items:center;justify-content:center}
    .preview-modal.show{display:flex}
    .preview-modal img,.preview-modal video{max-width:90%;max-height:90%;object-fit:contain}
    .preview-close{position:absolute;top:16px;right:16px;background:transparent;border:none;color:#fff;font-size:28px;cursor:pointer}
    .preview-filename{position:absolute;bottom:16px;left:50%;transform:translateX(-50%);color:#fff;font-size:14px;background:rgba(0,0,0,0.5);padding:8px 16px;border-radius:6px}
    .chat-fab{position:fixed;bottom:24px;right:24px;width:52px;height:52px;background:linear-gradient(135deg,#667eea,#764ba2);border-radius:50%;display:flex;align-items:center;justify-content:center;cursor:pointer;box-shadow:0 4px 12px rgba(102,126,234,0.4);z-index:150;border:none;color:#fff}
    .chat-fab:hover{transform:scale(1.05)}
    .chat-fab .material-icons-outlined{font-size:26px}
    .chat-fab.has-notes::after{content:'';position:absolute;top:6px;right:6px;width:10px;height:10px;background:var(--error);border-radius:50%;border:2px solid #fff}
    .chat-panel{position:fixed;bottom:90px;right:24px;width:340px;max-height:450px;background:var(--surface);border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,0.2);display:flex;flex-direction:column;z-index:150;opacity:0;visibility:hidden;transform:translateY(20px);transition:all 0.3s}
    .chat-panel.show{opacity:1;visibility:visible;transform:translateY(0)}
    .chat-header{padding:14px 16px;background:linear-gradient(135deg,#667eea,#764ba2);border-radius:12px 12px 0 0;display:flex;align-items:center;justify-content:space-between;color:#fff}
    .chat-header-title{display:flex;align-items:center;gap:8px;font-size:15px;font-weight:500}
    .chat-header-btn{background:rgba(255,255,255,0.2);border:none;color:#fff;width:28px;height:28px;border-radius:50%;cursor:pointer;display:flex;align-items:center;justify-content:center}
    .chat-header-btn:hover{background:rgba(255,255,255,0.3)}
    .chat-header-btn .material-icons-outlined{font-size:16px}
    .guest-notice{background:var(--warning);color:#000;padding:8px;font-size:11px;text-align:center}
    .chat-messages{flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:10px;max-height:280px;min-height:150px}
    .chat-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;color:var(--text2);text-align:center;padding:24px}
    .chat-empty .material-icons-outlined{font-size:40px;margin-bottom:8px;opacity:0.5}
    .chat-message{display:flex;flex-direction:column;max-width:85%;align-self:flex-end}
    .chat-bubble{padding:10px 14px;background:linear-gradient(135deg,#667eea,#764ba2);color:#fff;border-radius:14px 14px 4px 14px;font-size:13px;line-height:1.4;word-wrap:break-word}
    .chat-time{font-size:10px;color:var(--text2);margin-top:4px;text-align:right;padding-right:4px}
    .chat-input-area{padding:10px 12px;border-top:1px solid var(--border);display:flex;gap:8px;align-items:flex-end}
    .chat-input-area.disabled{background:var(--hover)}
    .chat-input{flex:1;padding:10px 14px;border:1px solid var(--border);border-radius:20px;font-size:13px;outline:none;resize:none;max-height:80px;line-height:1.4;font-family:inherit}
    .chat-input:focus{border-color:#667eea}
    .chat-input:disabled{background:var(--hover);cursor:not-allowed}
    .chat-send{width:38px;height:38px;background:linear-gradient(135deg,#667eea,#764ba2);border:none;border-radius:50%;color:#fff;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0}
    .chat-send:disabled{opacity:0.5;cursor:not-allowed}
    .chat-send .material-icons-outlined{font-size:18px}
    @media(max-width:768px){.sidebar{display:none}.file-grid{grid-template-columns:repeat(auto-fill,minmax(140px,1fr))}.search-bar{display:none}.chat-panel{width:calc(100% - 48px);right:24px}}
  </style>
</head>
<body>
  <header class="header">
    <div class="logo">
      <div class="logo-icon"><span class="material-icons-outlined">cloud</span></div>
      <span>Cloud</span>
    </div>
    <div class="search-bar"><input type="text" placeholder="Search files..." id="searchInput"></div>
    ${isGuest ? '<span class="guest-badge">Guest</span>' : ''}
    <div class="user-menu" id="userMenu">
      <div class="user-avatar">${username.charAt(0).toUpperCase()}</div>
      <span style="font-size:14px">${username}</span>
      <span class="material-icons-outlined" style="font-size:18px">expand_more</span>
    </div>
  </header>

  <div class="container">
    <aside class="sidebar">
      <button class="new-btn" id="newBtn" ${isGuest ? 'disabled' : ''}>
        <span class="material-icons-outlined">add</span>New
      </button>
      <div class="sidebar-item active"><span class="material-icons-outlined">${isGuest ? 'public' : 'folder'}</span>${isGuest ? 'Public Files' : 'My Files'}</div>
      <div class="sidebar-divider"></div>
      <a href="/logout" class="sidebar-item logout"><span class="material-icons-outlined">logout</span>Sign out</a>
      <div class="storage-info">
        <div class="storage-text" id="storageText">Loading...</div>
        <div class="storage-bar"><div class="storage-bar-fill" id="storageBar" style="width:0%"></div></div>
        <div class="storage-text">${isGuest ? 'Public files only' : '10 GB available'}</div>
      </div>
    </aside>

    <main class="main">
      <div class="toolbar">
        <div class="breadcrumb" id="breadcrumb"><span class="breadcrumb-item active" data-path="">${isGuest ? 'Public Files' : 'My Files'}</span></div>
        <div class="view-toggle">
          <button class="active" data-view="grid"><span class="material-icons-outlined">grid_view</span></button>
          <button data-view="list"><span class="material-icons-outlined">view_list</span></button>
        </div>
      </div>
      <div class="list-header" id="listHeader" style="display:none"><span></span><span>Name</span><span>Status</span><span>Size</span><span>Modified</span><span></span></div>
      <div class="file-grid" id="fileGrid"></div>
      <div class="file-list" id="fileList"></div>
      <div class="empty-state" id="emptyState" style="display:none">
        <span class="material-icons-outlined">${isGuest ? 'public_off' : 'folder_open'}</span>
        <div class="empty-state-title">${isGuest ? 'No public files' : 'No files yet'}</div>
        <div class="empty-state-text">${isGuest ? 'Admin has not shared any files' : 'Upload files to get started'}</div>
      </div>
    </main>
  </div>

  <div class="dropdown" id="newDropdown">
    <div class="dropdown-item" id="uploadFileBtn"><span class="material-icons-outlined">upload_file</span>Upload file</div>
    <div class="dropdown-item" id="uploadFolderBtn"><span class="material-icons-outlined">drive_folder_upload</span>Upload folder</div>
    <div class="dropdown-divider"></div>
    <div class="dropdown-item" id="newFolderBtn"><span class="material-icons-outlined">create_new_folder</span>New folder</div>
  </div>

  <div class="dropdown" id="userDropdown">
    <div class="dropdown-item"><span class="material-icons-outlined">person</span>${username} ${isGuest ? '(Guest)' : '(Admin)'}</div>
    <div class="dropdown-divider"></div>
    <a href="/logout" class="dropdown-item" style="text-decoration:none;color:var(--error)"><span class="material-icons-outlined" style="color:var(--error)">logout</span>Sign out</a>
  </div>

  <div class="dropdown" id="contextMenu">
    <div class="dropdown-item" data-action="preview"><span class="material-icons-outlined">visibility</span>Preview</div>
    <div class="dropdown-item" data-action="download"><span class="material-icons-outlined">download</span>Download</div>
    ${!isGuest ? `
    <div class="dropdown-divider"></div>
    <div class="dropdown-item" data-action="toggle-public"><span class="material-icons-outlined">public</span><span class="toggle-text">Make Public</span></div>
    <div class="dropdown-divider"></div>
    <div class="dropdown-item" data-action="delete"><span class="material-icons-outlined">delete</span>Delete</div>
    ` : ''}
  </div>

  <div class="modal-overlay" id="folderModal">
    <div class="modal">
      <div class="modal-title">New folder</div>
      <input type="text" class="modal-input" id="folderName" placeholder="Folder name">
      <div class="modal-actions">
        <button class="btn btn-text" id="cancelFolder">Cancel</button>
        <button class="btn btn-primary" id="createFolder">Create</button>
      </div>
    </div>
  </div>

  <div class="modal-overlay" id="deleteModal">
    <div class="modal">
      <div class="modal-title">Delete items?</div>
      <p style="margin-bottom:16px;color:var(--text2)"><span id="deleteCount">1</span> item(s) will be deleted.</p>
      <div class="modal-actions">
        <button class="btn btn-text" id="cancelDelete">Cancel</button>
        <button class="btn btn-danger" id="confirmDelete">Delete</button>
      </div>
    </div>
  </div>

  <div class="upload-progress" id="uploadProgress">
    <div style="display:flex;justify-content:space-between;font-size:13px"><span>Uploading...</span><span id="uploadPercent">0%</span></div>
    <div class="progress-bar"><div class="progress-fill" id="progressFill"></div></div>
  </div>

  <div class="selection-bar" id="selectionBar">
    <span id="selectedCount">0 selected</span>
    <button id="downloadSelected"><span class="material-icons-outlined">download</span>Download</button>
    ${!isGuest ? '<button id="deleteSelected"><span class="material-icons-outlined">delete</span>Delete</button>' : ''}
    <button id="clearSelection"><span class="material-icons-outlined">close</span></button>
  </div>

  <div class="preview-modal" id="previewModal">
    <button class="preview-close" id="closePreview"><span class="material-icons-outlined">close</span></button>
    <div id="previewContent"></div>
    <div class="preview-filename" id="previewFilename"></div>
  </div>

  <div class="toast" id="toast"></div>

  <button class="chat-fab" id="chatFab"><span class="material-icons-outlined">chat</span></button>

  <div class="chat-panel" id="chatPanel">
    <div class="chat-header">
      <div class="chat-header-title"><span class="material-icons-outlined">sticky_note_2</span>Notes</div>
      <div style="display:flex;gap:4px">
        ${!isGuest ? '<button class="chat-header-btn" id="clearNotes"><span class="material-icons-outlined">delete_sweep</span></button>' : ''}
        <button class="chat-header-btn" id="closeChat"><span class="material-icons-outlined">close</span></button>
      </div>
    </div>
    ${isGuest ? '<div class="guest-notice">👁️ View only - Guests cannot send</div>' : ''}
    <div class="chat-messages" id="chatMessages">
      <div class="chat-empty" id="chatEmpty">
        <span class="material-icons-outlined">edit_note</span>
        <div>No notes yet</div>
      </div>
    </div>
    <div class="chat-input-area ${isGuest ? 'disabled' : ''}">
      <textarea class="chat-input" id="chatInput" placeholder="${isGuest ? 'Guests cannot send' : 'Write a note...'}" rows="1" ${isGuest ? 'disabled' : ''}></textarea>
      <button class="chat-send" id="chatSend" ${isGuest ? 'disabled' : ''}><span class="material-icons-outlined">send</span></button>
    </div>
  </div>

  <input type="file" id="fileInput" multiple hidden>
  <input type="file" id="folderInput" webkitdirectory hidden>

<script>
const IS_GUEST = ${isGuest};
let currentPath = '';
let currentView = 'grid';
let selectedItems = new Set();
let allFiles = [];
let contextItem = null;

const $ = id => document.getElementById(id);
const fileGrid = $('fileGrid');
const fileList = $('fileList');
const emptyState = $('emptyState');
const listHeader = $('listHeader');
const contextMenu = $('contextMenu');
const toast = $('toast');
const previewModal = $('previewModal');

loadFiles();
loadStats();

async function loadFiles(prefix = '') {
  currentPath = prefix;
  try {
    const res = await fetch('/list?prefix=' + encodeURIComponent(prefix));
    const data = await res.json();
    allFiles = [...data.folders, ...data.files];
    renderFiles(allFiles);
    renderBreadcrumb(prefix);
  } catch (e) {
    showToast('Failed to load');
  }
}

async function loadStats() {
  try {
    const res = await fetch('/stats');
    const data = await res.json();
    const mb = (data.totalSize / 1024 / 1024).toFixed(2);
    $('storageText').textContent = IS_GUEST ? data.totalFiles + ' public file(s)' : mb + ' MB used';
    $('storageBar').style.width = Math.min((data.totalSize / (10*1024*1024*1024)) * 100, 100) + '%';
  } catch (e) {}
}

function renderFiles(items) {
  fileGrid.innerHTML = '';
  fileList.innerHTML = '';
  if (items.length === 0) {
    emptyState.style.display = 'block';
    fileGrid.style.display = 'none';
    return;
  }
  emptyState.style.display = 'none';
  fileGrid.style.display = currentView === 'grid' ? 'grid' : 'none';
  fileList.style.display = currentView === 'list' ? 'block' : 'none';
  listHeader.style.display = currentView === 'list' ? 'grid' : 'none';
  items.forEach(item => {
    if (currentView === 'grid') fileGrid.appendChild(createCard(item));
    else fileList.appendChild(createRow(item));
  });
}

function createCard(item) {
  const card = document.createElement('div');
  card.className = 'file-card';
  card.dataset.key = item.key;
  const isImg = item.type === 'file' && /\\.(jpg|jpeg|png|gif|webp|svg)$/i.test(item.name);
  const isVid = item.type === 'file' && /\\.(mp4|webm|mov)$/i.test(item.name);
  let preview = '';
  if (item.type === 'folder') preview = '<span class="material-icons-outlined" style="font-size:48px;color:#5f6368">folder</span>';
  else if (isImg) preview = '<img src="/files/' + encodeURIComponent(item.key) + '" loading="lazy">';
  else if (isVid) preview = '<span class="material-icons-outlined" style="color:#ea4335">smart_display</span>';
  else preview = '<span class="material-icons-outlined">' + getIcon(item.name) + '</span>';
  
  let toggle = '';
  if (!IS_GUEST && item.type === 'file') {
    toggle = '<button class="file-toggle ' + (item.isPublic ? 'is-public' : '') + '" onclick="event.stopPropagation();togglePublic(\\'' + item.key + '\\',' + !item.isPublic + ')"><span class="material-icons-outlined">' + (item.isPublic ? 'public' : 'public_off') + '</span></button>';
  }
  
  card.innerHTML = '<div class="file-preview">' + preview + toggle + '</div><div class="file-info"><div class="file-name">' + item.name + '</div><div class="file-meta">' + (item.type === 'folder' ? 'Folder' : formatSize(item.size)) + (item.type === 'file' && !IS_GUEST ? (item.isPublic ? ' <span class="public-badge">Public</span>' : ' <span class="private-badge">Private</span>') : '') + '</div></div>';
  card.onclick = e => handleClick(e, item);
  card.ondblclick = () => handleOpen(item);
  card.oncontextmenu = e => handleContext(e, item);
  return card;
}

function createRow(item) {
  const row = document.createElement('div');
  row.className = 'file-row';
  row.dataset.key = item.key;
  const icon = item.type === 'folder' ? 'folder' : getIcon(item.name);
  row.innerHTML = '<span class="material-icons-outlined" style="font-size:20px;color:var(--text2)">' + icon + '</span><span class="file-row-name">' + item.name + '</span><span class="file-row-size">' + (item.type === 'file' && !IS_GUEST ? (item.isPublic ? '<span class="public-badge">Public</span>' : '<span class="private-badge">Private</span>') : '-') + '</span><span class="file-row-size">' + (item.type === 'folder' ? '-' : formatSize(item.size)) + '</span><span class="file-row-date">' + (item.uploaded ? formatDate(item.uploaded) : '-') + '</span><span></span>';
  row.onclick = e => handleClick(e, item);
  row.ondblclick = () => handleOpen(item);
  row.oncontextmenu = e => handleContext(e, item);
  return row;
}

function getIcon(name) {
  const ext = name.split('.').pop().toLowerCase();
  const icons = {pdf:'picture_as_pdf',doc:'description',docx:'description',xls:'table_chart',xlsx:'table_chart',zip:'folder_zip',mp3:'audio_file',mp4:'smart_display',jpg:'image',jpeg:'image',png:'image',gif:'image',txt:'article'};
  return icons[ext] || 'insert_drive_file';
}

function formatSize(b) {
  if (!b) return '0 B';
  const k = 1024, s = ['B','KB','MB','GB'];
  const i = Math.floor(Math.log(b) / Math.log(k));
  return (b / Math.pow(k, i)).toFixed(1) + ' ' + s[i];
}

function formatDate(d) {
  return new Date(d).toLocaleDateString('en-US', {month:'short',day:'numeric'});
}

function renderBreadcrumb(path) {
  const parts = path ? path.split('/').filter(Boolean) : [];
  let html = '<span class="breadcrumb-item' + (!path ? ' active' : '') + '" data-path="">' + (IS_GUEST ? 'Public' : 'My Files') + '</span>';
  let p = '';
  parts.forEach((part, i) => {
    p += part + '/';
    html += '<span class="material-icons-outlined" style="font-size:16px;color:var(--text2)">chevron_right</span><span class="breadcrumb-item' + (i === parts.length - 1 ? ' active' : '') + '" data-path="' + p + '">' + part + '</span>';
  });
  $('breadcrumb').innerHTML = html;
  $('breadcrumb').querySelectorAll('.breadcrumb-item').forEach(el => el.onclick = () => loadFiles(el.dataset.path));
}

function handleClick(e, item) {
  if (e.ctrlKey || e.metaKey) toggleSelect(item.key);
  else { clearSelect(); addSelect(item.key); }
  updateSelectUI();
}

function handleOpen(item) {
  if (item.type === 'folder') loadFiles(item.key);
  else previewFile(item);
}

function previewFile(item) {
  const ext = item.name.split('.').pop().toLowerCase();
  const url = '/files/' + encodeURIComponent(item.key);
  if (['jpg','jpeg','png','gif','webp','svg'].includes(ext)) {
    $('previewContent').innerHTML = '<img src="' + url + '">';
  } else if (['mp4','webm','mov'].includes(ext)) {
    $('previewContent').innerHTML = '<video src="' + url + '" controls autoplay></video>';
  } else {
    window.open(url + '?download=true', '_blank');
    return;
  }
  $('previewFilename').textContent = item.name;
  previewModal.classList.add('show');
}

function addSelect(key) {
  selectedItems.add(key);
  document.querySelector('[data-key="' + CSS.escape(key) + '"]')?.classList.add('selected');
}

function toggleSelect(key) {
  if (selectedItems.has(key)) {
    selectedItems.delete(key);
    document.querySelector('[data-key="' + CSS.escape(key) + '"]')?.classList.remove('selected');
  } else addSelect(key);
}

function clearSelect() {
  selectedItems.forEach(k => document.querySelector('[data-key="' + CSS.escape(k) + '"]')?.classList.remove('selected'));
  selectedItems.clear();
  updateSelectUI();
}

function updateSelectUI() {
  $('selectedCount').textContent = selectedItems.size + ' selected';
  $('selectionBar').classList.toggle('show', selectedItems.size > 0);
}

function handleContext(e, item) {
  e.preventDefault();
  clearSelect();
  addSelect(item.key);
  updateSelectUI();
  contextItem = item;
  if (!IS_GUEST) {
    const txt = contextMenu.querySelector('.toggle-text');
    if (txt) txt.textContent = item.isPublic ? 'Make Private' : 'Make Public';
  }
  contextMenu.style.left = e.pageX + 'px';
  contextMenu.style.top = e.pageY + 'px';
  contextMenu.classList.add('show');
}

async function togglePublic(key, isPublic) {
  try {
    await fetch('/toggle-public', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({key, isPublic})
    });
    showToast(isPublic ? 'File is now public' : 'File is now private');
    loadFiles(currentPath);
  } catch (e) {
    showToast('Failed');
  }
}

document.addEventListener('click', e => {
  if (!contextMenu.contains(e.target)) contextMenu.classList.remove('show');
  if (!$('newDropdown').contains(e.target) && !$('newBtn').contains(e.target)) $('newDropdown').classList.remove('show');
  if (!$('userDropdown').contains(e.target) && !$('userMenu').contains(e.target)) $('userDropdown').classList.remove('show');
});

contextMenu.querySelectorAll('.dropdown-item').forEach(el => {
  el.onclick = () => {
    const action = el.dataset.action;
    const key = contextItem?.key;
    if (action === 'preview' && contextItem) previewFile(contextItem);
    else if (action === 'download') window.open('/files/' + encodeURIComponent(key) + '?download=true', '_blank');
    else if (action === 'toggle-public' && contextItem) togglePublic(key, !contextItem.isPublic);
    else if (action === 'delete') showDeleteModal([key]);
    contextMenu.classList.remove('show');
  };
});

$('newBtn').onclick = e => {
  const d = $('newDropdown');
  const r = e.target.closest('.new-btn').getBoundingClientRect();
  d.style.left = r.left + 'px';
  d.style.top = r.bottom + 4 + 'px';
  d.classList.toggle('show');
};

$('userMenu').onclick = e => {
  const d = $('userDropdown');
  const r = e.target.closest('.user-menu').getBoundingClientRect();
  d.style.left = (r.right - 180) + 'px';
  d.style.top = r.bottom + 4 + 'px';
  d.classList.toggle('show');
};

if (!IS_GUEST) {
  $('uploadFileBtn').onclick = () => { $('fileInput').click(); $('newDropdown').classList.remove('show'); };
  $('fileInput').onchange = e => { uploadFiles(e.target.files); e.target.value = ''; };
  $('uploadFolderBtn').onclick = () => { $('folderInput').click(); $('newDropdown').classList.remove('show'); };
  $('folderInput').onchange = e => { uploadFiles(e.target.files); e.target.value = ''; };
  $('newFolderBtn').onclick = () => { $('newDropdown').classList.remove('show'); $('folderModal').classList.add('show'); $('folderName').value = ''; $('folderName').focus(); };
  $('cancelFolder').onclick = () => $('folderModal').classList.remove('show');
  $('createFolder').onclick = async () => {
    const name = $('folderName').value.trim();
    if (!name) return;
    try {
      await fetch('/folder', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,parent:currentPath.replace(/\\/$/,'')})});
      showToast('Folder created');
      loadFiles(currentPath);
    } catch (e) { showToast('Failed'); }
    $('folderModal').classList.remove('show');
  };
  $('deleteSelected')?.addEventListener('click', () => showDeleteModal([...selectedItems]));
}

async function uploadFiles(files) {
  $('uploadProgress').classList.add('show');
  let done = 0;
  for (const file of files) {
    const fd = new FormData();
    fd.append('file', file);
    fd.append('folder', currentPath);
    try { await fetch('/upload', {method:'POST',body:fd}); } catch (e) {}
    done++;
    const pct = Math.round((done / files.length) * 100);
    $('progressFill').style.width = pct + '%';
    $('uploadPercent').textContent = pct + '%';
  }
  $('uploadProgress').classList.remove('show');
  $('progressFill').style.width = '0%';
  showToast(done + ' file(s) uploaded');
  loadFiles(currentPath);
  loadStats();
}

function showDeleteModal(keys) {
  $('deleteCount').textContent = keys.length;
  $('deleteModal').classList.add('show');
  $('deleteModal').dataset.keys = JSON.stringify(keys);
}

$('cancelDelete').onclick = () => $('deleteModal').classList.remove('show');
$('confirmDelete').onclick = async () => {
  const keys = JSON.parse($('deleteModal').dataset.keys || '[]');
  try {
    await fetch('/', {method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({keys})});
    showToast(keys.length + ' deleted');
    clearSelect();
    loadFiles(currentPath);
    loadStats();
  } catch (e) { showToast('Failed'); }
  $('deleteModal').classList.remove('show');
};

$('downloadSelected').onclick = () => selectedItems.forEach(k => window.open('/files/' + encodeURIComponent(k) + '?download=true', '_blank'));
$('clearSelection').onclick = clearSelect;

document.querySelectorAll('.view-toggle button').forEach(btn => {
  btn.onclick = () => {
    document.querySelectorAll('.view-toggle button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentView = btn.dataset.view;
    renderFiles(allFiles);
  };
});

$('searchInput').oninput = e => {
  const q = e.target.value.toLowerCase();
  renderFiles(q ? allFiles.filter(f => f.name.toLowerCase().includes(q)) : allFiles);
};

$('closePreview').onclick = () => { previewModal.classList.remove('show'); $('previewContent').innerHTML = ''; };
previewModal.onclick = e => { if (e.target === previewModal) { previewModal.classList.remove('show'); $('previewContent').innerHTML = ''; } };

function showToast(msg) {
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2500);
}

document.onkeydown = e => {
  if (e.key === 'Escape') {
    clearSelect();
    previewModal.classList.remove('show');
    document.querySelectorAll('.modal-overlay').forEach(m => m.classList.remove('show'));
    $('chatPanel').classList.remove('show');
  }
  if (e.key === 'Delete' && selectedItems.size > 0 && !IS_GUEST) showDeleteModal([...selectedItems]);
  if (e.key === 'a' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); allFiles.forEach(f => addSelect(f.key)); updateSelectUI(); }
};

// Chat
const chatFab = $('chatFab');
const chatPanel = $('chatPanel');
const chatInput = $('chatInput');
const chatMessages = $('chatMessages');
const chatEmpty = $('chatEmpty');
let notes = [];

loadNotes();

async function loadNotes() {
  try {
    const res = await fetch('/notes');
    if (res.ok) { notes = await res.json(); renderNotes(); }
  } catch (e) {}
}

async function saveNotes() {
  try { await fetch('/notes', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(notes)}); } catch (e) { showToast('Failed to save'); }
}

function renderNotes() {
  chatMessages.querySelectorAll('.chat-message').forEach(m => m.remove());
  if (notes.length === 0) { chatEmpty.style.display = 'flex'; chatFab.classList.remove('has-notes'); return; }
  chatEmpty.style.display = 'none';
  chatFab.classList.add('has-notes');
  notes.forEach((n, i) => {
    const el = document.createElement('div');
    el.className = 'chat-message';
    el.innerHTML = '<div class="chat-bubble">' + escapeHtml(n.text) + '</div><div class="chat-time">' + formatTime(n.time) + '</div>';
    if (!IS_GUEST) { el.ondblclick = () => deleteNote(i); el.title = 'Double-click to delete'; }
    chatMessages.insertBefore(el, chatEmpty);
  });
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function escapeHtml(t) { const d = document.createElement('div'); d.textContent = t; return d.innerHTML.replace(/\\n/g, '<br>'); }

function formatTime(ts) {
  const d = new Date(ts), now = new Date(), diff = now - d;
  if (diff < 60000) return 'Just now';
  if (diff < 3600000) return Math.floor(diff/60000) + 'm ago';
  if (diff < 86400000) return Math.floor(diff/3600000) + 'h ago';
  return d.toLocaleDateString('en-US', {month:'short',day:'numeric'});
}

async function sendNote() {
  const text = chatInput.value.trim();
  if (!text || IS_GUEST) return;
  notes.push({text, time: Date.now()});
  chatInput.value = '';
  renderNotes();
  await saveNotes();
}

async function deleteNote(i) {
  if (confirm('Delete this note?')) {
    notes.splice(i, 1);
    renderNotes();
    await saveNotes();
  }
}

chatFab.onclick = () => { chatPanel.classList.toggle('show'); if (chatPanel.classList.contains('show') && !IS_GUEST) chatInput.focus(); };
$('closeChat').onclick = () => chatPanel.classList.remove('show');
if (!IS_GUEST) {
  $('clearNotes')?.addEventListener('click', async () => {
    if (confirm('Delete all notes?')) { notes = []; renderNotes(); await saveNotes(); }
  });
  $('chatSend').onclick = sendNote;
  chatInput.onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendNote(); } };
}
</script>
</body>
</html>`;
}
