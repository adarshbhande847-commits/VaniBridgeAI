import React from 'react';
import { CheckCircleIcon, LoadingSpinner } from './Icon';

interface ProcessingLogProps {
  logs: string[];
  isProcessing: boolean;
}

export const ProcessingLog: React.FC<ProcessingLogProps> = ({ logs, isProcessing }) => {
  return (
    <div className="bg-slate-800/50 rounded-lg p-6 border border-slate-700 h-64 overflow-y-auto font-mono text-sm">
      <h3 className="text-slate-400 text-xs uppercase tracking-wider mb-4">System Terminal</h3>
      <ul className="space-y-3">
        {logs.map((log, index) => (
          <li key={index} className="flex items-start gap-3 animate-fadeIn">
            <span className="mt-0.5">
              {index === logs.length - 1 && isProcessing ? (
                <LoadingSpinner />
              ) : (
                <CheckCircleIcon />
              )}
            </span>
            <span className={index === logs.length - 1 ? "text-blue-300 font-semibold" : "text-slate-300"}>
              {log}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
};