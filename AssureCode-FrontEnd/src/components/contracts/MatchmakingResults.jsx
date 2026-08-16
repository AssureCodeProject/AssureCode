import React from 'react';
import { Star, ShieldCheck, Sparkles, CheckCircle2, DollarSign, Clock, MapPin, Key } from 'lucide-react';
import { Badge } from '../common/Badge';
import { formatHash } from '../../utils/cryptoUtils';

export function MatchmakingResults({ freelancers = [], onSelectFreelancer, selectedId }) {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h4 className="text-sm font-bold text-white flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-purple-400" />
            Sentence-BERT Ranked Freelancers
          </h4>
          <p className="text-xs text-slate-400">
            Semantic vector embeddings matched against requirement specification.
          </p>
        </div>
        <Badge variant="purple" size="xs">pgvector HNSW Match</Badge>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {freelancers.map(freelancer => {
          const isSelected = freelancer.id === selectedId;

          return (
            <div
              key={freelancer.id}
              onClick={() => onSelectFreelancer(freelancer.id)}
              className={`p-5 rounded-2xl border transition-all duration-200 cursor-pointer text-left relative ${
                isSelected
                  ? 'bg-brand-950/40 border-brand-500 shadow-lg shadow-brand-500/15 neon-border-brand'
                  : 'bg-slate-900/60 border-slate-800 hover:border-slate-700 hover:bg-slate-900'
              }`}
            >
              {/* Top Row: Avatar, Match Score, Basic Info */}
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-3">
                  <img
                    src={freelancer.avatar}
                    alt={freelancer.name}
                    className="w-12 h-12 rounded-full border border-indigo-500/40 object-cover"
                  />
                  <div>
                    <h5 className="text-sm font-bold text-white flex items-center gap-1.5">
                      {freelancer.name}
                      <ShieldCheck className="w-4 h-4 text-emerald-400" />
                    </h5>
                    <div className="text-xs text-indigo-300 font-mono">{freelancer.handle}</div>
                  </div>
                </div>

                {/* Match Score Badge */}
                <div className="text-right">
                  <div className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-purple-500/20 text-purple-300 font-mono font-bold text-xs border border-purple-500/40">
                    <Sparkles className="w-3 h-3 text-purple-400" />
                    {freelancer.matchScore}% Match
                  </div>
                  <div className="text-[10px] text-slate-500 mt-0.5">S-BERT Cosine</div>
                </div>
              </div>

              {/* Title & Bio */}
              <div className="mt-3">
                <div className="text-xs font-semibold text-slate-200">{freelancer.title}</div>
                <p className="text-xs text-slate-400 line-clamp-2 mt-1 leading-relaxed">
                  {freelancer.bio}
                </p>
              </div>

              {/* Skills Badges */}
              <div className="mt-3 flex flex-wrap gap-1.5">
                {freelancer.skills?.map((skill, idx) => (
                  <span
                    key={idx}
                    className="px-2 py-0.5 rounded text-[10px] font-mono bg-slate-800 text-slate-300 border border-slate-700"
                  >
                    {skill}
                  </span>
                ))}
              </div>

              {/* Stats Footer */}
              <div className="mt-4 pt-3 border-t border-slate-800/80 flex items-center justify-between text-xs text-slate-400">
                <div className="flex items-center gap-3">
                  <span className="font-semibold text-white font-mono">${freelancer.hourlyRate}/hr</span>
                  <span>•</span>
                  <span className="text-emerald-400 font-semibold">{freelancer.verifiedContractsCount} Verified</span>
                </div>

                <div className="text-[10px] font-mono text-slate-500 flex items-center gap-1">
                  <Key className="w-3 h-3 text-indigo-400" />
                  <span>{formatHash(freelancer.publicKey, 4, 4)}</span>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
