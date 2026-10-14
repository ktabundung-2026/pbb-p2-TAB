// ==========================================
// 1. Inisialisasi Database Lokal (IndexedDB)
// ==========================================
const db = new Dexie("PbbP2LocalDB");

// Definisi skema tabel lokal
db.version(1).stores({
  wajibPajak: "++id_lokal, nop, nama, tahun_tagihan, total_tagihan, desa",
  antreanInput: "++id, nop, nama, tahun_tagihan, total_tagihan, desa, status",
  operator: "id, desa, username, password" // Menggunakan struktur password_operator
});

// ==========================================
// 2. Modul Autentikasi & Akun Operator
// ==========================================

// Unduh/Sinkronkan data operator dari Database Utama ke IndexedDB (Jalankan saat Online)
async function syncOperatorLokal() {
  if (navigator.onLine && typeof supabaseClient !== 'undefined') {
    try {
      const { data, error } = await supabaseClient
        .from('password_operator')
        .select('id, username, password, desa');

      if (error) throw error;

      if (data && data.length > 0) {
        await db.operator.clear();
        await db.operator.bulkAdd(data);
        console.log("✅ Data operator berhasil diperbarui untuk penggunaan offline.");
      }
    } catch (err) {
      console.warn("⚠️ Gagal mengunduh data operator ke lokal:", err.message);
    }
  }
}

// Verifikasi Login (Mendukung Online & Offline)
async function verifikasiLoginOperator(desaPilihan, usernameInput, passwordInput) {
  // A. Cek pencocokan dari Database Lokal terlebih dahulu
  const operatorLokal = await db.operator
    .where({ desa: desaPilihan, username: usernameInput, password: passwordInput })
    .first();

  if (operatorLokal) {
    // Simpan sesi ke LocalStorage (tahan lama meski browser ditutup/offline)
    localStorage.setItem('operator_desa', operatorLokal.desa);
    localStorage.setItem('operator_username', operatorLokal.username);
    return { success: true, data: operatorLokal, mode: 'lokal' };
  }

  // B. Jika tidak ada di lokal dan sedang ONLINE, cek langsung ke Database Utama
  if (navigator.onLine && typeof supabaseClient !== 'undefined') {
    try {
      const { data, error } = await supabaseClient
        .from('password_operator')
        .select('*')
        .eq('desa', desaPilihan)
        .eq('username', usernameInput)
        .eq('password', passwordInput)
        .maybeSingle();

      if (error) throw error;

      if (data) {
        localStorage.setItem('operator_desa', data.desa);
        localStorage.setItem('operator_username', data.username);
        
        // Perbarui cache lokal agar login berikutnya bisa offline
        await syncOperatorLokal();
        return { success: true, data: data, mode: 'online' };
      }
    } catch (err) {
      return { success: false, message: "Terjadi kesalahan sistem: " + err.message };
    }
  }

  // C. Jika gagal atau dalam keadaan offline tanpa cache
  if (!navigator.onLine) {
    return { 
      success: false, 
      message: `❌ Mode Offline:\nData akun untuk ${usernameInput} (${desaPilihan}) belum tersimpan di perangkat ini. Hubungkan ke internet untuk login pertama kali.` 
    };
  }

  return { 
    success: false, 
    message: `❌ Login Gagal!\nUsername/Password salah atau tidak terdaftar di ${desaPilihan}.` 
  };
}

// Cek Sesi Aktif Operator
function cekSesiOperator() {
  const desa = localStorage.getItem('operator_desa');
  const username = localStorage.getItem('operator_username');
  if (desa && username) {
    return { desa, username };
  }
  return null;
}

// Logout Operator
function logoutOperator() {
  localStorage.removeItem('operator_desa');
  localStorage.removeItem('operator_username');
  window.location.href = 'index.html';
}

// ==========================================
// 3. Modul Pengolahan Data PBB-P2 & Sync
// ==========================================

// Tambah Data WP (Otomatis deteksi Online/Offline)
async function tambahDataWP(dataBaru) {
  if (navigator.onLine && typeof supabaseClient !== 'undefined') {
    try {
      const { data, error } = await supabaseClient
        .from('pbb_p2')
        .insert([dataBaru]);

      if (error) throw error;

      await db.wajibPajak.add(dataBaru);
      return { success: true, mode: 'online' };
    } catch (err) {
      console.warn("Gagal terhubung ke Database Utama, menyimpan ke antrean offline...", err);
      return await simpanOffline(dataBaru);
    }
  } else {
    return await simpanOffline(dataBaru);
  }
}

// Simpan ke Antrean Offline Lokal
async function simpanOffline(dataBaru) {
  await db.antreanInput.add({ ...dataBaru, status: 'pending' });
  await db.wajibPajak.add(dataBaru);
  return { success: true, mode: 'offline' };
}

// Ambil Data WP (Menampilkan data dari Database Utama atau Cache Lokal)
async function ambilDataWP() {
  if (navigator.onLine && typeof supabaseClient !== 'undefined') {
    try {
      const { data, error } = await supabaseClient.from('pbb_p2').select('*');
      if (error) throw error;

      // Update cache lokal
      await db.wajibPajak.clear();
      await db.wajibPajak.bulkAdd(data);
      return data;
    } catch (err) {
      console.warn("Gagal mengambil data dari Database Utama, memuat dari cadangan lokal...", err);
      return await db.wajibPajak.toArray();
    }
  } else {
    return await db.wajibPajak.toArray();
  }
}

// Sinkronisasi Otomatis Antrean Data saat Koneksi Internet Kembali Terhubung
window.addEventListener('online', async () => {
  console.log("🌐 Koneksi terhubung kembali! Memulai sinkronisasi data...");
  
  // Sync akun operator
  await syncOperatorLokal();

  // Sync antrean input WP ke Database Utama
  if (typeof supabaseClient !== 'undefined') {
    const antrean = await db.antreanInput.where('status').equals('pending').toArray();

    for (const item of antrean) {
      const { id, status, ...payload } = item;
      const { error } = await supabaseClient.from('pbb_p2').insert([payload]);

      if (!error) {
        await db.antreanInput.delete(id);
      }
    }
    console.log("✅ Sinkronisasi data offline ke Database selesai!");
  }
});
