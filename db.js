// 1. Inisialisasi Dexie (IndexedDB)
const db = new Dexie("PbbP2LocalDB");
db.version(1).stores({
  wajibPajak: "++id_lokal, nop, nama, tahun_tagihan, total_tagihan, desa",
  antreanInput: "++id, nop, nama, tahun_tagihan, total_tagihan, desa, status"
});

// 2. Fungsi Input Data WP (Dipakai di Form Input)
async function tambahDataWP(dataBaru) {
  if (navigator.onLine) {
    try {
      // Jika Online: Kirim langsung ke Supabase
      const { data, error } = await supabaseClient
        .from('pbb_p2') // ganti dengan nama tabel Supabase Anda
        .insert([dataBaru]);

      if (error) throw error;

      // Simpan juga ke cache lokal
      await db.wajibPajak.add(dataBaru);
      alert("Data berhasil disimpan ke Supabase!");
    } catch (err) {
      console.error("Gagal ke Supabase, menyimpan secara offline...", err);
      await simpanOffline(dataBaru);
    }
  } else {
    // Jika Offline: Masukkan ke Antrean Offline
    await simpanOffline(dataBaru);
  }
}

async function simpanOffline(dataBaru) {
  await db.antreanInput.add({ ...dataBaru, status: 'pending' });
  await db.wajibPajak.add(dataBaru);
  alert("Mode Offline: Data tersimpan di perangkat lokal dan akan dikirim saat online!");
}

// 3. Fungsi Ambil Data WP (Dipakai di Dashboard/Tabel Tampil Data)
async function ambilDataWP() {
  if (navigator.onLine) {
    try {
      // Ambil dari Supabase
      const { data, error } = await supabaseClient.from('pbb_p2').select('*');
      if (error) throw error;

      // Update cache lokal
      await db.wajibPajak.clear();
      await db.wajibPajak.bulkAdd(data);
      return data;
    } catch (err) {
      console.warn("Gagal mengambil data dari Supabase, memuat dari lokal...", err);
      return await db.wajibPajak.toArray();
    }
  } else {
    // Ambil dari IndexedDB lokal
    return await db.wajibPajak.toArray();
  }
}

// 4. Sinkronisasi Otomatis ketika Koneksi Pulih (Online)
window.addEventListener('online', async () => {
  console.log("Koneksi terhubung! Memulai sinkronisasi data...");
  const antrean = await db.antreanInput.where('status').equals('pending').toArray();

  for (const item of antrean) {
    const { id, status, ...payload } = item;
    const { error } = await supabaseClient.from('pbb_p2').insert([payload]);

    if (!error) {
      await db.antreanInput.delete(id);
    }
  }
  console.log("Sinkronisasi data offline selesai!");
});
