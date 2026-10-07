// Historical probe is archived with its two completed responses; user disabled further Ultrafast use.
console.error(JSON.stringify({event:'capability_probe_disabled',code:'ultrafast_disabled_by_user'}));
process.exitCode=1;
