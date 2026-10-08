'use strict';
module.exports = function(source) {
  return `const style=document.createElement('style');style.textContent=${JSON.stringify(source)};document.head.appendChild(style);`;
};
