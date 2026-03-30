import { Router } from 'express';
import { collection, getDocs, doc, updateDoc, query, orderBy, limit, Firestore } from 'firebase/firestore';
import type { Request, Response, NextFunction } from 'express';

declare module 'express-session' {
  interface SessionData {
    adminLoggedIn?: boolean;
    adminFlash?: string;
    adminFlashType?: string;
  }
}

const ADMIN_EMAIL = 'kisekitw@gmail.com';

function escHtml(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function fmtDate(iso: string | undefined | null): string {
  if (!iso) return '-';
  try {
    return new Date(iso).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
  } catch {
    return String(iso);
  }
}

const HEAD = `<!DOCTYPE html>
<html lang="zh-TW">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>親師悄悄話 | 後台管理</title>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/css/all.min.css">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/admin-lte@3.2/dist/css/adminlte.min.css">
  <link rel="stylesheet" href="https://cdn.datatables.net/1.13.8/css/dataTables.bootstrap4.min.css">
  <link href="https://fonts.googleapis.com/css2?family=Noto+Sans+TC:wght@300;400;500;700&display=swap" rel="stylesheet">
  <!-- jQuery + DataTables + Chart.js must load BEFORE any inline scripts -->
  <script src="https://cdn.jsdelivr.net/npm/jquery@3.7.1/dist/jquery.min.js"></script>
  <script src="https://cdn.datatables.net/1.13.8/js/jquery.dataTables.min.js"></script>
  <script src="https://cdn.datatables.net/1.13.8/js/dataTables.bootstrap4.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
  <style>
    body, .nav-sidebar .nav-link p, .brand-text { font-family: 'Noto Sans TC', sans-serif !important; }
    .trial-info { font-size: 0.7rem; display: block; }
    #logsTable tbody tr:hover { background: #f0f4ff; }
  </style>
</head>`;

// Bootstrap + AdminLTE loaded at body end (after DOM)
const SCRIPTS = `
  <script src="https://cdn.jsdelivr.net/npm/bootstrap@4.6.2/dist/js/bootstrap.bundle.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/admin-lte@3.2/dist/js/adminlte.min.js"></script>`;

function loginPage(error?: string): string {
  return `${HEAD}
<body class="hold-transition login-page" style="background:#434343">
<div class="login-box">
  <div class="login-logo">
    <a href="/admin/login" style="color:#fff"><b>親師</b>悄悄話</a>
  </div>
  <div class="card">
    <div class="card-body login-card-body">
      <p class="login-box-msg">後台管理系統</p>
      ${error ? `<div class="alert alert-danger py-2">${escHtml(error)}</div>` : ''}
      <form action="/admin/login" method="post">
        <div class="input-group mb-3">
          <input type="email" name="email" class="form-control" placeholder="電子郵件"
            value="${escHtml(ADMIN_EMAIL)}" required>
          <div class="input-group-append">
            <div class="input-group-text"><i class="fas fa-envelope"></i></div>
          </div>
        </div>
        <div class="input-group mb-3">
          <input type="password" name="password" class="form-control" placeholder="密碼" required autofocus>
          <div class="input-group-append">
            <div class="input-group-text"><i class="fas fa-lock"></i></div>
          </div>
        </div>
        <div class="row">
          <div class="col-12">
            <button type="submit" class="btn btn-primary btn-block">登入後台</button>
          </div>
        </div>
      </form>
    </div>
  </div>
</div>
${SCRIPTS}
</body></html>`;
}

function sidebar(active: string): string {
  const item = (page: string, icon: string, label: string) =>
    `<li class="nav-item">
      <a href="/admin/${page}" class="nav-link ${active === page ? 'active' : ''}">
        <i class="nav-icon fas fa-${icon}"></i><p>${label}</p>
      </a>
    </li>`;

  return `
  <aside class="main-sidebar sidebar-dark-primary elevation-4">
    <a href="/admin/dashboard" class="brand-link">
      <i class="fas fa-comment-dots ml-3" style="color:#90caf9;font-size:1.4rem"></i>
      <span class="brand-text font-weight-light ml-2">親師悄悄話</span>
    </a>
    <div class="sidebar">
      <div class="user-panel mt-3 pb-3 mb-3 d-flex align-items-center">
        <div class="image ml-1"><i class="fas fa-user-shield text-white" style="font-size:1.6rem"></i></div>
        <div class="info ml-2">
          <span class="d-block text-white-50" style="font-size:0.8rem">系統管理員</span>
          <span class="d-block text-white" style="font-size:0.75rem">${escHtml(ADMIN_EMAIL)}</span>
        </div>
      </div>
      <nav class="mt-2">
        <ul class="nav nav-pills nav-sidebar flex-column" data-widget="treeview" role="menu">
          ${item('dashboard', 'tachometer-alt', '數據總覽')}
          ${item('users', 'users', '使用者管理')}
        </ul>
      </nav>
    </div>
  </aside>`;
}

function wrapLayout(active: string, content: string, extraScripts = ''): string {
  return `${HEAD}
<body class="hold-transition sidebar-mini layout-fixed">
<div class="wrapper">
  <nav class="main-header navbar navbar-expand navbar-white navbar-light border-bottom">
    <ul class="navbar-nav">
      <li class="nav-item">
        <a class="nav-link" data-widget="pushmenu" href="#"><i class="fas fa-bars"></i></a>
      </li>
      <li class="nav-item d-none d-sm-inline-block">
        <span class="nav-link font-weight-bold">親師悄悄話 後台管理</span>
      </li>
    </ul>
    <ul class="navbar-nav ml-auto">
      <li class="nav-item">
        <a href="/admin/logout" class="nav-link text-danger">
          <i class="fas fa-sign-out-alt"></i> 登出
        </a>
      </li>
    </ul>
  </nav>
  ${sidebar(active)}
  <div class="content-wrapper">
    ${content}
  </div>
  <footer class="main-footer text-sm">
    <strong>親師悄悄話</strong> &copy; ${new Date().getFullYear()} 後台管理系統
  </footer>
</div>
${SCRIPTS}
${extraScripts}
</body></html>`;
}

function getFlash(session: any): string {
  if (!session.adminFlash) return '';
  const type = session.adminFlashType || 'info';
  const msg = escHtml(session.adminFlash);
  delete session.adminFlash;
  delete session.adminFlashType;
  return `<div class="alert alert-${type} alert-dismissible fade show mx-3 mt-3">
    ${msg}
    <button type="button" class="close" data-dismiss="alert"><span>&times;</span></button>
  </div>`;
}

function dashboardContent(stats: {
  totalUsers: number; teachers: number; parents: number;
  todayActive: number; recentLogs: any[];
}, flash: string): string {
  const logsRows = stats.recentLogs.map((log) => {
    const statusBadge = log.status === 'success'
      ? '<span class="badge badge-success">成功</span>'
      : log.status === 'error'
        ? '<span class="badge badge-danger">錯誤</span>'
        : '<span class="badge badge-secondary">資訊</span>';
    const typeBadge = log.userType === 'teacher'
      ? '<span class="badge badge-primary">老師</span>'
      : log.userType === 'parent'
        ? '<span class="badge badge-warning">家長</span>'
        : '<span class="badge badge-light text-dark">-</span>';
    const preview = escHtml((log.output || log.error || '-').substring(0, 80));
    const dataJson = escHtml(JSON.stringify(log));
    const userType = escHtml(log.userType || '');
    const statusVal = escHtml(log.status || '');
    return `<tr style="cursor:pointer" data-log="${dataJson}" data-usertype="${userType}" data-status="${statusVal}" onclick="showLogDetail(this)">
      <td style="white-space:nowrap">${fmtDate(log.timestamp)}</td>
      <td>${typeBadge}</td>
      <td>${escHtml(log.action || '-')}</td>
      <td>${statusBadge}</td>
      <td style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${preview}</td>
      <td><span class="btn btn-xs btn-outline-secondary"><i class="fas fa-eye"></i></span></td>
    </tr>`;
  }).join('');

  const unset = stats.totalUsers - stats.teachers - stats.parents;

  return `
  <div class="content-header">
    <div class="container-fluid">
      <div class="row mb-2">
        <div class="col-sm-6"><h1 class="m-0">數據總覽</h1></div>
        <div class="col-sm-6">
          <ol class="breadcrumb float-sm-right">
            <li class="breadcrumb-item active">Dashboard</li>
          </ol>
        </div>
      </div>
    </div>
  </div>
  <section class="content">
    <div class="container-fluid">
      ${flash}
      <div class="row">
        <div class="col-lg-3 col-6">
          <div class="small-box bg-info">
            <div class="inner"><h3>${stats.totalUsers}</h3><p>總使用者</p></div>
            <div class="icon"><i class="fas fa-users"></i></div>
            <a href="/admin/users" class="small-box-footer">管理使用者 <i class="fas fa-arrow-circle-right"></i></a>
          </div>
        </div>
        <div class="col-lg-3 col-6">
          <div class="small-box bg-success">
            <div class="inner"><h3>${stats.teachers}</h3><p>老師</p></div>
            <div class="icon"><i class="fas fa-chalkboard-teacher"></i></div>
            <a href="/admin/users" class="small-box-footer">查看 <i class="fas fa-arrow-circle-right"></i></a>
          </div>
        </div>
        <div class="col-lg-3 col-6">
          <div class="small-box bg-warning">
            <div class="inner"><h3>${stats.parents}</h3><p>家長</p></div>
            <div class="icon"><i class="fas fa-user-friends"></i></div>
            <a href="/admin/users" class="small-box-footer">查看 <i class="fas fa-arrow-circle-right"></i></a>
          </div>
        </div>
        <div class="col-lg-3 col-6">
          <div class="small-box bg-danger">
            <div class="inner"><h3>${stats.todayActive}</h3><p>今日 AI 成功次數</p></div>
            <div class="icon"><i class="fas fa-chart-bar"></i></div>
            <a href="#" class="small-box-footer">統計 <i class="fas fa-arrow-circle-right"></i></a>
          </div>
        </div>
      </div>
      <div class="row">
        <div class="col-md-4">
          <div class="card card-primary card-outline">
            <div class="card-header"><h3 class="card-title">使用者分布</h3></div>
            <div class="card-body d-flex justify-content-center">
              <canvas id="userTypePie" style="max-height:260px;max-width:260px"></canvas>
            </div>
          </div>
        </div>
        <div class="col-md-8">
          <div class="card card-primary card-outline">
            <div class="card-header">
              <h3 class="card-title">操作記錄（最新 50 筆）</h3>
              <div class="card-tools">
                <a href="/admin/dashboard" class="btn btn-sm btn-outline-secondary">
                  <i class="fas fa-sync-alt"></i> 重新整理
                </a>
              </div>
            </div>
            <!-- Filter toolbar -->
            <div class="card-body pb-0 pt-2">
              <div class="d-flex flex-wrap align-items-center" style="gap:8px">
                <span class="text-muted small mr-1">類型：</span>
                <div class="btn-group btn-group-sm" id="typeFilter">
                  <button class="btn btn-primary active" data-val="user">老師 ＋ 家長</button>
                  <button class="btn btn-outline-primary" data-val="teacher">老師</button>
                  <button class="btn btn-outline-warning" data-val="parent">家長</button>
                  <button class="btn btn-outline-secondary" data-val="all">全部</button>
                </div>
                <span class="text-muted small ml-3 mr-1">狀態：</span>
                <div class="btn-group btn-group-sm" id="statusFilter">
                  <button class="btn btn-secondary active" data-val="all">全部</button>
                  <button class="btn btn-outline-success" data-val="success">成功</button>
                  <button class="btn btn-outline-danger" data-val="error">錯誤</button>
                </div>
              </div>
            </div>
            <div class="card-body p-0 mt-2">
              <div class="table-responsive">
                <table id="logsTable" class="table table-hover table-sm mb-0" style="width:100%">
                  <thead class="thead-light">
                    <tr><th>時間</th><th>類型</th><th>動作</th><th>狀態</th><th>內容預覽</th><th></th></tr>
                  </thead>
                  <tbody>
                    ${logsRows || '<tr><td colspan="6" class="text-center text-muted py-3">暫無記錄</td></tr>'}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </section>

  <!-- Log Detail Modal -->
  <div class="modal fade" id="logDetailModal" tabindex="-1" role="dialog">
    <div class="modal-dialog modal-lg modal-dialog-scrollable" role="document">
      <div class="modal-content">
        <div class="modal-header">
          <h5 class="modal-title">
            <i class="fas fa-file-alt mr-2"></i>操作記錄詳細
          </h5>
          <button type="button" class="close" data-dismiss="modal"><span>&times;</span></button>
        </div>
        <div class="modal-body">
          <table class="table table-sm table-bordered mb-3">
            <tbody>
              <tr><th style="width:120px">時間</th><td id="ld-time"></td></tr>
              <tr><th>使用者 ID</th><td id="ld-userId" class="text-monospace small"></td></tr>
              <tr><th>顯示名稱</th><td id="ld-displayName"></td></tr>
              <tr><th>類型</th><td id="ld-userType"></td></tr>
              <tr><th>動作</th><td id="ld-action"></td></tr>
              <tr><th>狀態</th><td id="ld-status"></td></tr>
              <tr><th>模型</th><td id="ld-model"></td></tr>
            </tbody>
          </table>
          <div id="ld-input-section">
            <h6 class="font-weight-bold">輸入內容</h6>
            <pre id="ld-input" class="bg-light p-3 rounded small" style="white-space:pre-wrap;word-break:break-all;max-height:200px;overflow-y:auto"></pre>
          </div>
          <div id="ld-output-section" class="mt-3">
            <h6 class="font-weight-bold">AI 輸出</h6>
            <pre id="ld-output" class="bg-light p-3 rounded small" style="white-space:pre-wrap;word-break:break-all;max-height:300px;overflow-y:auto"></pre>
          </div>
          <div id="ld-error-section" class="mt-3" style="display:none">
            <h6 class="font-weight-bold text-danger">錯誤訊息</h6>
            <pre id="ld-error" class="bg-light p-3 rounded small text-danger" style="white-space:pre-wrap;word-break:break-all"></pre>
          </div>
        </div>
        <div class="modal-footer">
          <button type="button" class="btn btn-secondary" data-dismiss="modal">關閉</button>
        </div>
      </div>
    </div>
  </div>

  <script>
    // Chart
    new Chart(document.getElementById('userTypePie'), {
      type: 'doughnut',
      data: {
        labels: ['老師', '家長', '未設定'],
        datasets: [{ data: [${stats.teachers}, ${stats.parents}, ${unset}],
          backgroundColor: ['#3b82f6','#f59e0b','#9ca3af'], borderWidth: 2 }]
      },
      options: { responsive: true, plugins: { legend: { position: 'bottom' } } }
    });

    // --- DataTables filter state ---
    var activeTypeFilter = 'user';    // 預設：老師＋家長
    var activeStatusFilter = 'all';

    // Custom row-level filter (runs on every draw)
    $.fn.dataTable.ext.search.push(function(settings, _data, dataIndex) {
      if (settings.nTable.id !== 'logsTable') return true;
      var row = settings.aoData[dataIndex].nTr;
      if (!row) return true;
      var ut = row.getAttribute('data-usertype') || '';
      var st = row.getAttribute('data-status') || '';

      var typeOk = activeTypeFilter === 'all' ? true
        : activeTypeFilter === 'user' ? (ut === 'teacher' || ut === 'parent')
        : ut === activeTypeFilter;

      var statusOk = activeStatusFilter === 'all' ? true : st === activeStatusFilter;
      return typeOk && statusOk;
    });

    $(document).ready(function() {
      var table = $('#logsTable').DataTable({
        order: [[0, 'desc']],
        pageLength: 15,
        lengthMenu: [10, 15, 25, 50],
        language: {
          search: '搜尋：',
          lengthMenu: '每頁 _MENU_ 筆',
          info: '第 _START_–_END_ 筆，共 _TOTAL_ 筆',
          infoEmpty: '共 0 筆',
          zeroRecords: '沒有符合的記錄',
          paginate: { first:'«', last:'»', next:'›', previous:'‹' }
        },
        columnDefs: [
          { orderable: false, targets: [1, 4, 5] },
          { searchable: false, targets: [1, 5] }
        ]
      });

      // 類型篩選
      $('#typeFilter button').on('click', function() {
        $('#typeFilter button').each(function() {
          var v = $(this).data('val');
          $(this).removeClass('active btn-primary btn-warning btn-secondary')
            .addClass(v === 'teacher' ? 'btn-outline-primary'
              : v === 'parent' ? 'btn-outline-warning' : 'btn-outline-secondary');
        });
        var val = $(this).data('val');
        $(this).removeClass('btn-outline-primary btn-outline-warning btn-outline-secondary')
          .addClass('active')
          .addClass(val === 'teacher' ? 'btn-primary'
            : val === 'parent' ? 'btn-warning' : 'btn-secondary');
        activeTypeFilter = val;
        table.draw();
      });

      // 狀態篩選
      $('#statusFilter button').on('click', function() {
        $('#statusFilter button').each(function() {
          var v = $(this).data('val');
          $(this).removeClass('active btn-secondary btn-success btn-danger')
            .addClass(v === 'success' ? 'btn-outline-success'
              : v === 'error' ? 'btn-outline-danger' : 'btn-outline-secondary');
        });
        var val = $(this).data('val');
        $(this).removeClass('btn-outline-success btn-outline-danger btn-outline-secondary')
          .addClass('active')
          .addClass(val === 'success' ? 'btn-success'
            : val === 'error' ? 'btn-danger' : 'btn-secondary');
        activeStatusFilter = val;
        table.draw();
      });

      // 套用預設篩選（老師＋家長）
      table.draw();
    });

    function showLogDetail(row) {
      const log = JSON.parse(row.getAttribute('data-log'));

      document.getElementById('ld-time').textContent = log.timestamp || '-';
      document.getElementById('ld-userId').textContent = log.userId || '-';
      document.getElementById('ld-displayName').textContent = log.displayName || '-';
      document.getElementById('ld-userType').textContent =
        log.userType === 'teacher' ? '老師' : log.userType === 'parent' ? '家長' : (log.userType || '-');
      document.getElementById('ld-action').textContent = log.action || '-';
      document.getElementById('ld-model').textContent = log.model || '-';

      const statusEl = document.getElementById('ld-status');
      statusEl.innerHTML = log.status === 'success'
        ? '<span class="badge badge-success">成功</span>'
        : log.status === 'error'
          ? '<span class="badge badge-danger">錯誤</span>'
          : '<span class="badge badge-secondary">' + (log.status || '-') + '</span>';

      // Input
      let inputText = log.input || '';
      try { inputText = JSON.stringify(JSON.parse(inputText), null, 2); } catch(e) {}
      document.getElementById('ld-input').textContent = inputText || '（無）';
      document.getElementById('ld-input-section').style.display = inputText ? '' : 'none';

      // Output
      document.getElementById('ld-output').textContent = log.output || '（無）';
      document.getElementById('ld-output-section').style.display = log.output ? '' : 'none';

      // Error
      if (log.error) {
        document.getElementById('ld-error').textContent = log.error + (log.stack ? '\\n\\n' + log.stack : '');
        document.getElementById('ld-error-section').style.display = '';
      } else {
        document.getElementById('ld-error-section').style.display = 'none';
      }

      $('#logDetailModal').modal('show');
    }
  </script>`;
}

function usersContent(users: any[], flash: string): string {
  const now = new Date();
  const rows = users.map(u => {
    const typeBadge = u.userType === 'teacher'
      ? '<span class="badge badge-primary">老師</span>'
      : u.userType === 'parent'
        ? '<span class="badge badge-warning">家長</span>'
        : '<span class="badge badge-secondary">未設定</span>';

    const planBadge = u.plan === 'paid'
      ? '<span class="badge badge-success">付費</span>'
      : '<span class="badge badge-light text-dark border">免費</span>';

    const hasTrial = u.trialEndDate && new Date(u.trialEndDate) > now;
    const trialCell = hasTrial
      ? `<span class="badge badge-info">體驗中</span>
         <span class="trial-info text-muted">${fmtDate(u.trialEndDate)}</span>`
      : u.trialEndDate
        ? `<span class="badge badge-secondary">已過期</span>`
        : '<span class="text-muted">-</span>';

    const shortId = escHtml((u.userId || '').substring(0, 10) + '…');
    const name = escHtml(u.displayName || '未知');
    const btnLabel = hasTrial ? '延長三天' : '開通三天體驗';
    const btnStyle = hasTrial ? 'btn-info' : 'btn-success';

    return `<tr>
      <td>${name}</td>
      <td><small class="text-muted" title="${escHtml(u.userId || '')}">${shortId}</small></td>
      <td>${typeBadge}</td>
      <td>${planBadge}</td>
      <td class="text-center">${u.usageToday ?? 0} / 3</td>
      <td><small>${fmtDate(u.lastActiveAt)}</small></td>
      <td>${trialCell}</td>
      <td>
        <form method="post"
          action="/admin/users/${encodeURIComponent(u.userId || '')}/grant-trial"
          style="display:inline"
          onsubmit="return confirm('確認為 ${name} ${hasTrial ? '延長' : '開通'}三天體驗？')">
          <button type="submit" class="btn btn-xs ${btnStyle}">
            <i class="fas fa-gift mr-1"></i>${btnLabel}
          </button>
        </form>
      </td>
    </tr>`;
  }).join('');

  return `
  <div class="content-header">
    <div class="container-fluid">
      <div class="row mb-2">
        <div class="col-sm-6"><h1 class="m-0">使用者管理</h1></div>
        <div class="col-sm-6">
          <ol class="breadcrumb float-sm-right">
            <li class="breadcrumb-item"><a href="/admin/dashboard">Dashboard</a></li>
            <li class="breadcrumb-item active">使用者</li>
          </ol>
        </div>
      </div>
    </div>
  </div>
  <section class="content">
    <div class="container-fluid">
      ${flash}
      <div class="card card-primary card-outline">
        <div class="card-header">
          <h3 class="card-title">所有使用者（共 ${users.length} 人）</h3>
          <div class="card-tools">
            <a href="/admin/users" class="btn btn-sm btn-outline-secondary">
              <i class="fas fa-sync-alt"></i> 重新整理
            </a>
          </div>
        </div>
        <div class="card-body p-0">
          <div class="table-responsive">
            <table class="table table-hover table-striped mb-0">
              <thead class="thead-dark">
                <tr>
                  <th>顯示名稱</th>
                  <th>使用者 ID</th>
                  <th>類型</th>
                  <th>方案</th>
                  <th class="text-center">今日使用</th>
                  <th>最後活動</th>
                  <th>三天體驗</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                ${rows || '<tr><td colspan="8" class="text-center text-muted py-4">目前無使用者資料</td></tr>'}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  </section>`;
}

export function createAdminRouter(getDb: () => Firestore) {
  const router = Router();

  function requireAdmin(req: Request, res: Response, next: NextFunction) {
    if (req.session?.adminLoggedIn) return next();
    res.redirect('/admin/login');
  }

  // GET /admin → redirect
  router.get('/', (_req, res) => res.redirect('/admin/dashboard'));

  // GET /admin/login
  router.get('/login', (req, res) => {
    if (req.session?.adminLoggedIn) return res.redirect('/admin/dashboard');
    res.send(loginPage());
  });

  // POST /admin/login
  router.post('/login', (req: Request, res: Response) => {
    const { email, password } = req.body as { email?: string; password?: string };
    const adminPassword = process.env.ADMIN_PASSWORD;
    if (!adminPassword) {
      return void res.send(loginPage('伺服器未設定 ADMIN_PASSWORD，請聯繫系統管理員。'));
    }
    if (email?.trim() === ADMIN_EMAIL && password === adminPassword) {
      req.session.adminLoggedIn = true;
      return void res.redirect('/admin/dashboard');
    }
    res.send(loginPage('電子郵件或密碼錯誤'));
  });

  // GET /admin/logout
  router.get('/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/admin/login'));
  });

  // GET /admin/dashboard
  router.get('/dashboard', requireAdmin, async (req, res) => {
    try {
      const db = getDb();
      const today = new Date().toISOString().split('T')[0];

      const [usersSnap, logsSnap, todaySnap] = await Promise.all([
        getDocs(collection(db, 'users')),
        getDocs(query(collection(db, 'logs'), orderBy('timestamp', 'desc'), limit(50))),
        getDocs(query(collection(db, 'logs'), orderBy('timestamp', 'desc'), limit(500))),
      ]);

      const todayActive = todaySnap.docs.filter(d => {
        const ts: string = d.data().timestamp || '';
        return ts.startsWith(today) && d.data().status === 'success';
      }).length;

      const displayNameMap: Record<string, string> = {};
      usersSnap.docs.forEach(d => {
        const u = d.data();
        if (u.displayName) displayNameMap[d.id] = u.displayName;
      });

      const stats = {
        totalUsers: usersSnap.size,
        teachers: usersSnap.docs.filter(d => d.data().userType === 'teacher').length,
        parents: usersSnap.docs.filter(d => d.data().userType === 'parent').length,
        todayActive,
        recentLogs: logsSnap.docs.map(d => {
          const log = d.data();
          return { ...log, displayName: displayNameMap[log.userId] || null };
        }),
      };

      const flash = getFlash(req.session);
      res.send(wrapLayout('dashboard', dashboardContent(stats, flash)));
    } catch (e: any) {
      res.send(wrapLayout('dashboard',
        `<section class="content"><div class="container-fluid mt-3">
          <div class="alert alert-danger">錯誤：${escHtml(e.toString())}</div>
        </div></section>`
      ));
    }
  });

  // GET /admin/users
  router.get('/users', requireAdmin, async (req, res) => {
    try {
      const db = getDb();
      const snap = await getDocs(collection(db, 'users'));
      const users = snap.docs.map(d => d.data() as any);
      users.sort((a, b) => (b.lastActiveAt || '').localeCompare(a.lastActiveAt || ''));

      const flash = getFlash(req.session);
      res.send(wrapLayout('users', usersContent(users, flash)));
    } catch (e: any) {
      res.send(wrapLayout('users',
        `<section class="content"><div class="container-fluid mt-3">
          <div class="alert alert-danger">錯誤：${escHtml(e.toString())}</div>
        </div></section>`
      ));
    }
  });

  // POST /admin/users/:userId/grant-trial
  router.post('/users/:userId/grant-trial', requireAdmin, async (req, res) => {
    const { userId } = req.params;
    try {
      const db = getDb();
      const trialEndDate = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
      await updateDoc(doc(db, 'users', userId), { trialEndDate });
      req.session.adminFlash = `已成功開通三天無限制體驗（到期時間：${fmtDate(trialEndDate)}）`;
      req.session.adminFlashType = 'success';
    } catch (e: any) {
      req.session.adminFlash = `操作失敗：${e.message}`;
      req.session.adminFlashType = 'danger';
    }
    res.redirect('/admin/users');
  });

  return router;
}
