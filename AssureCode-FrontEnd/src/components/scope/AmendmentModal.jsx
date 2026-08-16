import React, { useState } from 'react';
import { useApp } from '../../context/AppContext';
import { Modal } from '../common/Modal';
import { FileEdit, DollarSign, Calendar, Sparkles, ShieldCheck, ArrowRight } from 'lucide-react';

export function AmendmentModal() {
  const { isAmendmentModalOpen, setIsAmendmentModalOpen, activeContract, submitAmendment } = useApp();

  const [formData, setFormData] = useState({
    title: 'Add React Native Mobile Application Layer',
    addedScope: 'Develop cross-platform iOS and Android mobile client with biometric login and push notification sync.',
    budgetAdjustment: '1200',
    deadlineExtension: '10'
  });

  const handleSubmit = (e) => {
    e.preventDefault();
    submitAmendment(formData);
  };

  return (
    <Modal
      isOpen={isAmendmentModalOpen}
      onClose={() => setIsAmendmentModalOpen(false)}
      title="Propose Contract Scope Amendment"
      maxWidth="max-w-xl"
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <p className="text-xs text-slate-400">
          When Scope Guard flags an out-of-scope request (&lt; 27.31% similarity), submitting an amendment re-computes the Merkle Root and adjusts escrow commitments on the ledger.
        </p>

        <div>
          <label className="block text-xs font-semibold uppercase tracking-wider text-slate-400 mb-1">
            Amendment Title
          </label>
          <input
            type="text"
            value={formData.title}
            onChange={e => setFormData({ ...formData, title: e.target.value })}
            className="w-full px-3.5 py-2 rounded-xl bg-slate-900 border border-slate-800 focus:border-brand-500 focus:outline-none text-xs text-white"
            placeholder="e.g. Additional Mobile App Module"
            required
          />
        </div>

        <div>
          <label className="block text-xs font-semibold uppercase tracking-wider text-slate-400 mb-1">
            Extended Technical Scope
          </label>
          <textarea
            rows={3}
            value={formData.addedScope}
            onChange={e => setFormData({ ...formData, addedScope: e.target.value })}
            className="w-full px-3.5 py-2 rounded-xl bg-slate-900 border border-slate-800 focus:border-brand-500 focus:outline-none text-xs text-slate-300"
            placeholder="Detailed description of new deliverables"
            required
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-slate-400 mb-1">
              Budget Adjustment (+$ USD)
            </label>
            <input
              type="number"
              value={formData.budgetAdjustment}
              onChange={e => setFormData({ ...formData, budgetAdjustment: e.target.value })}
              className="w-full px-3.5 py-2 rounded-xl bg-slate-900 border border-slate-800 focus:border-brand-500 focus:outline-none text-xs text-emerald-400 font-mono font-bold"
              placeholder="1200"
              required
            />
          </div>

          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-slate-400 mb-1">
              Deadline Extension (Days)
            </label>
            <input
              type="number"
              value={formData.deadlineExtension}
              onChange={e => setFormData({ ...formData, deadlineExtension: e.target.value })}
              className="w-full px-3.5 py-2 rounded-xl bg-slate-900 border border-slate-800 focus:border-brand-500 focus:outline-none text-xs text-white font-mono"
              placeholder="10"
              required
            />
          </div>
        </div>

        <div className="p-3 rounded-xl bg-brand-950/40 border border-brand-500/30 text-xs text-slate-300 flex items-start gap-2">
          <ShieldCheck className="w-4 h-4 text-indigo-400 flex-shrink-0 mt-0.5" />
          <span>
            Executing this amendment appends a <code className="text-indigo-300 font-mono">CONTRACT_AMENDED</code> block to the PostgreSQL hash chain with the new Merkle Root.
          </span>
        </div>

        <div className="flex justify-end gap-2 pt-3 border-t border-slate-800">
          <button
            type="button"
            onClick={() => setIsAmendmentModalOpen(false)}
            className="px-4 py-2 rounded-xl bg-slate-800 text-slate-300 text-xs font-semibold hover:bg-slate-700"
          >
            Cancel
          </button>
          <button
            type="submit"
            className="flex items-center gap-1.5 px-5 py-2 rounded-xl bg-brand-600 hover:bg-brand-500 text-white text-xs font-bold shadow-lg shadow-brand-500/25"
          >
            <span>Execute Scope Amendment</span>
            <ArrowRight className="w-4 h-4" />
          </button>
        </div>
      </form>
    </Modal>
  );
}
