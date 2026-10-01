<!doctype html>
<html lang="th">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>ระบบจัดการร้าน — หลังบ้าน</title>
  <?php /* ไฟล์หน้าเว็บทุกตัวติดป้ายรุ่น ?v=… — อัปเดตแล้วเบราว์เซอร์ต้องโหลดไฟล์ใหม่ (app/Libraries/AssetVersion.php) */ ?>
  <meta name="paynest-build" content="<?= esc(\App\Libraries\AssetVersion::build()) ?>">
  <meta name="paynest-icons" content="<?= esc(\App\Libraries\AssetVersion::url('/icons.svg')) ?>">
  <link rel="stylesheet" href="<?= esc(\App\Libraries\AssetVersion::url('/styles.css')) ?>">
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><text y='26' font-size='26'>🏪</text></svg>">
</head>
<body>
  <div id="root"></div>
  <div id="toasts"></div>
  <?php /* import map ต้องมาก่อนสคริปต์ module ตัวแรก · ที่อยู่ของ app.js ต้องตรงกับใน map ทุกตัวอักษร ไม่งั้นโหลดซ้ำเป็นสองตัว */ ?>
  <script type="importmap"><?= \App\Libraries\AssetVersion::importMap() ?></script>
  <script type="module" src="<?= esc(\App\Libraries\AssetVersion::url('/js/app.js')) ?>"></script>
</body>
</html>
