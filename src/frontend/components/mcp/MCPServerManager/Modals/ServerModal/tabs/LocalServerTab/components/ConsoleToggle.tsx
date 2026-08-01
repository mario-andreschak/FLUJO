'use client';

import React from 'react';
import VisibilityIcon from '@mui/icons-material/Visibility';
import VisibilityOffIcon from '@mui/icons-material/VisibilityOff';
import { useI18n } from '@/frontend/contexts/I18nContext';

interface ConsoleToggleProps {
  isVisible: boolean;
  toggleVisibility: () => void;
}

const ConsoleToggle: React.FC<ConsoleToggleProps> = ({
  isVisible,
  toggleVisibility
}) => {
  const { t } = useI18n();
  return (
    <button
      type="button"
      onClick={toggleVisibility}
      className="p-1 rounded-full hover:bg-gray-200 dark:hover:bg-gray-700 flex items-center"
      title={isVisible ? t('mcp.local.console.hide') : t('mcp.local.console.show')}
    >
      {isVisible ? (
        <>
          <span className="mr-1 text-sm">{t('mcp.local.console.hide')}</span>
          <VisibilityOffIcon fontSize="small" />
        </>
      ) : (
        <>
          <span className="mr-1 text-sm">{t('mcp.local.console.show')}</span>
          <VisibilityIcon fontSize="small" />
        </>
      )}
    </button>
  );
};

export default ConsoleToggle;
