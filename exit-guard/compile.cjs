const solc = require('solc');
const fs = require('fs');
const src = fs.readFileSync('contracts/ExitGuardExecutor.sol','utf8');
const input = {
  language: 'Solidity',
  sources: { 'ExitGuardExecutor.sol': { content: src } },
  settings: { optimizer: { enabled: true, runs: 200 }, outputSelection: { '*': { '*': ['abi','evm.bytecode.object'] } } }
};
const out = JSON.parse(solc.compile(JSON.stringify(input)));
const errs = (out.errors||[]).filter(e=>e.severity==='error');
(out.errors||[]).forEach(e=>console.log(e.severity.toUpperCase()+':', e.formattedMessage.split('\n')[0]));
if (errs.length) process.exit(1);
const c = out.contracts['ExitGuardExecutor.sol']['ExitGuardExecutor'];
fs.mkdirSync('artifacts',{recursive:true});
fs.writeFileSync('artifacts/ExitGuardExecutor.json', JSON.stringify({abi:c.abi, bytecode:'0x'+c.evm.bytecode.object},null,2));
console.log('COMPILED OK. bytecode bytes:', c.evm.bytecode.object.length/2, '| abi entries:', c.abi.length);
