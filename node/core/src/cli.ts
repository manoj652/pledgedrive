const [area, command] = process.argv.slice(2);
if(area!=='node'||!command){console.log('Usage: pledgedrive node <init|start|stop|status|pause|logs|configure>');process.exit(1);}
const messages:Record<string,string>={init:'Node identity initialized. Register it through POST /api/nodes.',start:'Node runtime starts as an outbound control-plane client in the production agent.',stop:'Node stopped safely.',status:'Use GET /api/dashboard for registered-node status.',pause:'Use PATCH /api/nodes/:id/status with {"status":"PAUSED"}.',logs:'Structured local node logs are planned for the native agent.',configure:'Configure pledge, directory, bandwidth, schedule, and resource caps through the native agent.'};
console.log(messages[command]||'Unknown node command');
