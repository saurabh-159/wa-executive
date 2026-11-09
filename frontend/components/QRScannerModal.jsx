// frontend/components/QRScannerModal.jsx
"use client";

import { QrCode, Smartphone, RefreshCw } from "lucide-react";

export default function QRScannerModal({ qrData }) {
  if (!qrData || qrData.connected) return null;

  return (
    <div className="bg-white border-2 border-dashed border-zinc-300 rounded-2xl p-6 shadow-sm mb-6">
      <div className="flex flex-col md:flex-row items-center gap-6 justify-between">
        <div className="space-y-3 max-w-md text-left">
          <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-amber-50 text-amber-800 text-xs font-semibold border border-amber-200">
            <QrCode className="w-3.5 h-3.5" /> WhatsApp Not Linked
          </div>
          <h2 className="text-lg font-bold text-zinc-900">
            Link Your WhatsApp Account
          </h2>
          <p className="text-xs text-zinc-600 leading-relaxed">
            WhatsApp conversations aur commitments track karne ke liye QR scan karein:
          </p>
          <ol className="text-xs text-zinc-500 space-y-1 list-decimal list-inside">
            <li>Apne phone me WhatsApp open karein.</li>
            <li><strong>Settings</strong> &gt; <strong>Linked Devices</strong> par click karein.</li>
            <li><strong>Link a Device</strong> select karke is QR ko scan karein.</li>
          </ol>
        </div>

        {/* QR Display */}
        <div className="flex flex-col items-center justify-center p-3 bg-zinc-50 border border-zinc-200 rounded-xl min-w-[200px] min-h-[200px]">
          {qrData.qr_image ? (
            <img
              src={qrData.qr_image}
              alt="WhatsApp QR Code"
              className="w-44 h-44 rounded-lg shadow-xs"
            />
          ) : (
            <div className="flex flex-col items-center justify-center space-y-2 py-8 text-zinc-400">
              <RefreshCw className="w-6 h-6 animate-spin text-zinc-500" />
              <span className="text-xs">Generating QR...</span>
            </div>
          )}
          <span className="text-[10px] text-zinc-400 mt-2 flex items-center gap-1">
            <Smartphone className="w-3 h-3" /> Auto-refreshes every 5s
          </span>
        </div>
      </div>
    </div>
  );
}