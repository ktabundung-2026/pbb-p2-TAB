// ============================================================================
// 1. INISIALISASI DATABASE LOKAL (IndexedDB via Dexie.js)
// ============================================================================
const db = new Dexie("PbbP2LocalDB");

db.version(1).stores({
  wajibPajak: "++id_lokal, nop, nama, tahun_tagihan, total_tagihan, desa",
  pembayaranPajak: "++id_lokal, nop, tahun_tagihan, jumlah_bayar, tanggal_setor, desa",
  antreanInput: "++id, tipe, nop, nama, tahun_tagihan, total_tagihan, jumlah_bayar, tanggal_setor, desa, status",
  operator: "id, desa, username, password"
});

// ============================================================================
// 2. MODUL AUTENTIKASI & AKUN OPERATOR
// ============================================================================

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
      console.warn("⚠️ Gagal mengunduh data operator ke lokal:", err.message);
    }
  }
}

async function verifikasiLoginOperator(desaPilihan, usernameInput, passwordInput) {
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
        await syncOperatorLokal();
        return { success: true, data: data, mode: 'online' };
      }
    } catch (err) {
      return { success: false, message: "Gagal terhubung ke Database: " + err.message };
    }
  }

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

function cekSesiOperator() {
  const desa = localStorage.getItem('operator_desa');
  const username = localStorage.getItem('operator_username');
  if (desa && username) {
    return { desa, username };
  }
  return null;
}

function logoutOperator() {
  if (confirm("Apakah Anda yakin ingin keluar dari portal operator?")) {
    localStorage.removeItem('operator_desa');
    localStorage.removeItem('operator_username');
    window.location.href = 'index.html';
  }
}

// ============================================================================
// 3. MODUL PENGOLAHAN DATA PBB-P2 & SINKRONISASI
// ============================================================================

async function tambahDataWP(dataBaru) {
  if (!navigator.onLine || typeof supabaseClient === 'undefined') {
    return await simpanOffline(dataBaru);
  }

  try {
    let tableName = dataBaru.jumlah_bayar !== undefined ? 'pembayaran_pajak' : 'wajib_pajak';
    
    const { error } = await supabaseClient
      .from(tableName)
      .insert([dataBaru]);

    if (error) throw error;

    if (tableName === 'wajib_pajak') {
      await db.wajibPajak.add(dataBaru);
    } else {
      await db.pembayaranPajak.add(dataBaru);
    }

    return { success: true, mode: 'online' };
  } catch (err) {
    console.warn("Panggilan Database Utama gagal, mengalihkan ke antrean offline...", err);
    return await simpanOffline(dataBaru);
  }
}

async function simpanOffline(dataBaru) {
  const tipeData = dataBaru.jumlah_bayar !== undefined ? 'pembayaran' : 'wp_baru';

  await db.antreanInput.add({
    ...dataBaru,
    tipe: tipeData,
    status: 'pending',
    createdAt: new Date().toISOString()
  });

  if (tipeData === 'wp_baru') {
    await db.wajibPajak.add(dataBaru);
  } else {
    await db.pembayaranPajak.add(dataBaru);
  }

  return { success: true, mode: 'offline' };
}

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
// 4. OTOMATISASI SINKRONISASI ANTREAN
// ============================================================================
window.addEventListener('online', async () => {
  console.log("🌐 Koneksi terhubung kembali! Memulai sinkronisasi...");

  await syncOperatorLokal();

  if (typeof supabaseClient !== 'undefined') {
    try {
      const antrean = await db.antreanInput.where('status').equals('pending').toArray();

      for (const item of antrean) {
        const { id, tipe, status, createdAt, ...payload } = item;
        let tableName = tipe === 'pembayaran' ? 'pembayaran_pajak' : 'wajib_pajak';

        const { error } = await supabaseClient.from(tableName).insert([payload]);

        if (!error) {
          await db.antreanInput.delete(id);
          console.log(`✅ Data antrean [${tipe}] NOP ${payload.nop} tersinkronisasi.`);
        }
      }

      if (typeof loadData === 'function') {
        loadData();
      }
    } catch (err) {
      console.warn("Gagal melakukan sinkronisasi otomatis:", err.message);
    }
  }
});
