// ============================================================================
// 1. INISIALISASI DATABASE LOKAL (IndexedDB via Dexie.js)
// ============================================================================
const db = new Dexie("PbbP2LocalDB");

// Definisi skema tabel IndexedDB lokal
db.version(1).stores({
  wajibPajak: "++id_lokal, nop, nama, tahun_tagihan, total_tagihan, desa",
  pembayaranPajak: "++id_lokal, nop, tahun_tagihan, jumlah_bayar, tanggal_setor, desa",
  antreanInput: "++id, tipe, nop, nama, tahun_tagihan, total_tagihan, jumlah_bayar, tanggal_setor, desa, status",
  operator: "id, desa, username, password" // Cache akun operator dari password_operator
});

// ============================================================================
// 2. MODUL AUTENTIKASI & AKUN OPERATOR (HYBRID ONLINE / OFFLINE)
// ============================================================================

/**
 * Mengunduh data operator dari Database Utama ke IndexedDB lokal.
 * Hanya dijalankan saat ada koneksi internet.
 */
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
        console.log("✅ Data akun operator berhasil diperbarui untuk penggunaan offline.");
      }
    } catch (err) {
      console.warn("⚠️ Gagal mengunduh data operator ke lokal (Offline Mode):", err.message);
    }
  }
}

/**
 * Memeriksa login operator secara hybrid (Lokal/IndexedDB dulu, lalu Database Utama if needed).
 */
async function verifikasiLoginOperator(desaPilihan, usernameInput, passwordInput) {
  // A. Cek kecocokan di IndexedDB lokal terlebih dahulu (Bisa bekerja baik Online maupun Offline)
  try {
    const operatorLokal = await db.operator
      .where({ desa: desaPilihan, username: usernameInput, password: passwordInput })
      .first();

    if (operatorLokal) {
      localStorage.setItem('operator_desa', operatorLokal.desa);
      localStorage.setItem('operator_username', operatorLokal.username);
      return { success: true, data: operatorLokal, mode: 'lokal' };
    }
  } catch (e) {
    console.warn("Mengecek kredensial lokal gagal, mencoba koneksi utama...", e);
  }

  // B. Jika tidak ditemukan di lokal dan dalam posisi ONLINE, coba ke Database Utama
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
        
        // Simpan/Perbarui cache lokal agar login berikutnya bisa offline
        await syncOperatorLokal();
        return { success: true, data: data, mode: 'online' };
      }
    } catch (err) {
      return { success: false, message: "Gagal terhubung ke Database: " + err.message };
    }
  }

  // C. Jika gagal dan sedang Offline
  if (!navigator.onLine) {
    return { 
      success: false, 
      message: `❌ Mode Offline:\nAkun ${usernameInput} (${desaPilihan}) belum tersimpan di perangkat ini. Hubungkan internet untuk login pertama kali.` 
    };
  }

  return { 
    success: false, 
    message: `❌ Login Gagal!\nUsername/Password salah atau tidak terdaftar di ${desaPilihan}.` 
  };
}

/**
 * Memeriksa sesi login aktif dari localStorage.
 */
function cekSesiOperator() {
  const desa = localStorage.getItem('operator_desa');
  const username = localStorage.getItem('operator_username');
  if (desa && username) {
    return { desa, username };
  }
  return null;
}

/**
 * Menghapus sesi login operator dan mengalihkan ke halaman login.
 */
function logoutOperator() {
  if (confirm("Apakah Anda yakin ingin keluar dari portal operator?")) {
    localStorage.removeItem('operator_desa');
    localStorage.removeItem('operator_username');
    window.location.href = 'index.html';
  }
}

// ============================================================================
// 3. MODUL PENGOLAHAN DATA PBB-P2 & SINKRONISASI (ANTI "FAILED TO FETCH")
// ============================================================================

/**
 * Menyimpan data Wajib Pajak baru atau Pembayaran Pajak.
 * Secara otomatis memilih jalur Direct Upload (Online) atau Antrean Offline.
 */
async function tambahDataWP(dataBaru) {
  // 1. JIKA OFFLINE: Langsung simpan ke antrean lokal tanpa memanggil Supabase SDK
  if (!navigator.onLine || typeof supabaseClient === 'undefined') {
    return await simpanOffline(dataBaru);
  }

  // 2. JIKA ONLINE: Coba kirim ke Database Utama dengan Penanganan Exception Strict
  try {
    let tableName = dataBaru.jumlah_bayar !== undefined ? 'pembayaran_pajak' : 'wajib_pajak';
    
    const { error } = await supabaseClient
      .from(tableName)
      .insert([dataBaru]);

    if (error) throw error;

    // Cache juga ke memori lokal
    if (tableName === 'wajib_pajak') {
      await db.wajibPajak.add(dataBaru);
    } else {
      await db.pembayaranPajak.add(dataBaru);
    }

    return { success: true, mode: 'online' };
  } catch (err) {
    console.warn("Panggilan Database Utama gagal (Sinyal terputus), mengalihkan ke antrean offline...", err);
    return await simpanOffline(dataBaru);
  }
}

/**
 * Menyimpan data ke Antrean Offline (IndexedDB) ketika koneksi internet tidak tersedia.
 */
async function simpanOffline(dataBaru) {
  const tipeData = dataBaru.jumlah_bayar !== undefined ? 'pembayaran' : 'wp_baru';

  await db.antreanInput.add({
    ...dataBaru,
    tipe: tipeData,
    status: 'pending',
    createdAt: new Date().toISOString()
  });

  // Simpan juga ke cache lokal agar tabel tampilan langsung ter-update secara realtime
  if (tipeData === 'wp_baru') {
    await db.wajibPajak.add(dataBaru);
  } else {
    await db.pembayaranPajak.add(dataBaru);
  }

  return { success: true, mode: 'offline' };
}

/**
 * Membaca seluruh data Wajib Pajak dan Pembayaran secara efisien.
 * Mengutamakan keselamatan panggilan jaringan saat offline.
 */
async function ambilDataWP(desaFilter, isAdminKecamatan) {
  // A. BACA DARI INDEXEDDB LOKAL JIKA SEDANG OFFLINE (Mencegah Error TypeError: Failed to fetch)
  if (!navigator.onLine || typeof supabaseClient === 'undefined') {
    console.log("📲 Mode Offline: Membaca data PBB-P2 dari IndexedDB lokal...");
    return await ambilDataDariLokal(desaFilter, isAdminKecamatan);
  }

  // B. BACA DARI DATABASE UTAMA JIKA ONLINE
  try {
    const { data: dataWP, error: errWP } = await supabaseClient
      .from('wajib_pajak')
      .select('*');

    if (errWP) throw errWP;

    // Perbarui Cache Wajib Pajak di IndexedDB lokal
    if (dataWP && dataWP.length > 0) {
      await db.wajibPajak.clear();
      await db.wajibPajak.bulkAdd(dataWP);
    }

    return await ambilDataDariLokal(desaFilter, isAdminKecamatan);

  } catch (err) {
    console.warn("⚠️ Terjadi kesalahan koneksi saat mengambil data utama, menggunakan cadangan lokal:", err.message);
    return await ambilDataDariLokal(desaFilter, isAdminKecamatan);
  }
}

/**
 * Helper untuk menyaring data dari IndexedDB berdasarkan hak akses Desa/Kecamatan.
 */
async function ambilDataDariLokal(desaFilter, isAdminKecamatan) {
  let listWP = await db.wajibPajak.toArray();

  if (!isAdminKecamatan) {
    listWP = listWP.filter(item => item.desa === desaFilter);
  } else if (desaFilter && desaFilter !== 'SEMUA') {
    listWP = listWP.filter(item => item.desa === desaFilter);
  }

  return listWP;
}

// ============================================================================
// 4. OTOMATISASI SINKRONISASI ANTREAN DATA SAAT KONEKSI INTERNET PULIH
// ============================================================================
window.addEventListener('online', async () => {
  console.log("🌐 Koneksi internet terhubung kembali! Memulai proses sinkronisasi...");

  // 1. Sync data akun operator
  await syncOperatorLokal();

  // 2. Sync antrean input WP & Pembayaran Pajak ke Database Utama
  if (typeof supabaseClient !== 'undefined') {
    try {
      const antrean = await db.antreanInput.where('status').equals('pending').toArray();

      for (const item of antrean) {
        const { id, tipe, status, createdAt, ...payload } = item;
        let tableName = tipe === 'pembayaran' ? 'pembayaran_pajak' : 'wajib_pajak';

        const { error } = await supabaseClient.from(tableName).insert([payload]);

        if (!error) {
          // Hapus dari antrean jika sukses terkirim
          await db.antreanInput.delete(id);
          console.log(`✅ Data antrean [${tipe}] NOP ${payload.nop} berhasil dikirim ke Database.`);
        }
      }

      // Refresh tampilan jika halaman dashboard aktif
      if (typeof loadData === 'function') {
        loadData();
      }
    } catch (err) {
      console.warn("Gagal melakukan sinkronisasi otomatis:", err.message);
    }
  }
});
