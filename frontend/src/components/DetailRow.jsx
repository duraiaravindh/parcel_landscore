import React from "react";
export default function DetailRow({ label, value, highlight }) {
return (
<div className={`flex justify-between py-2 ${highlight ? 'bg-emerald-50 px-2 rounded' : ''}`}>
<span className="text-slate-600 text-sm">{label}</span>
<span className={`text-slate-900 text-sm ${highlight ? 'font-semibold' : ''}`}>{value}</span>
</div>
);
}