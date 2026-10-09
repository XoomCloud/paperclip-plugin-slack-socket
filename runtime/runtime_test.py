import importlib.util,json,pathlib,unittest,subprocess,tempfile,shutil,os
ROOT=pathlib.Path(__file__).parent
spec=importlib.util.spec_from_file_location('installer',ROOT/'install.py');installer=importlib.util.module_from_spec(spec);spec.loader.exec_module(installer)
class RuntimeTests(unittest.TestCase):
    def test_wrapper_is_fixed_dispatch_no_secret_argv(self):
        wrapper=installer.wrapper('selected-employee')
        self.assertIn('tempfile.mkstemp',wrapper)
        self.assertIn('"-n"',wrapper)
        self.assertIn('"selected-employee"',wrapper)
        self.assertIn('finally:',wrapper)
        compile(wrapper,'wrapper','exec')
    def test_checksum_tamper_detected(self):
        with tempfile.TemporaryDirectory() as temp:
            root=pathlib.Path(temp);(root/'sample').write_text('wrong');(root/'SHA256SUMS').write_text('0'*64+'  sample\n')
            old=installer.ROOT;installer.ROOT=root
            try:
                with self.assertRaises(SystemExit):installer.verify_checksums()
            finally:installer.ROOT=old
    def test_unknown_server_patch_refuses_without_mutation(self):
        with tempfile.TemporaryDirectory() as temp:
            root=pathlib.Path(temp);(root/'package.json').write_text(json.dumps({'version':'2026.916.1'}));(root/'dist/services').mkdir(parents=True)
            target=root/'dist/services/heartbeat.js';target.write_text('unknown source')
            result=subprocess.run([os.sys.executable,str(ROOT/'patch-session.py'),'--server-root',str(root),'--apply'],capture_output=True)
            self.assertNotEqual(result.returncode,0);self.assertEqual(target.read_text(),'unknown source');self.assertFalse((root/'dist/services/heartbeat.xoomai-original').exists())
    @unittest.skipUnless(os.name=='posix','Ubuntu path validation')
    def test_roster_validation_rejects_cross_employee_overlap_and_missing_ids(self):
        cfg=json.loads((ROOT/'config.example.json').read_text())
        with self.assertRaises(SystemExit):installer.validate(cfg)
        cfg.update(companyId='11111111-1111-1111-1111-111111111111',baseUrl='https://example.ts.net',slackTeamId='T123')
        cfg['slackBotTokenRefs']=['encrypted-ref'];cfg['paperclipApiKeyRef']='service-ref'
        cfg['employees']=[dict(key='sales',agentId='22222222-2222-2222-2222-222222222222',linuxUser='xa-sales',engine='codex',workspace='/srv/xoomai/agents/sales/workspace',nativeHistory='/srv/xoomai/agents/sales/native-history',binary='/usr/bin/codex')]
        self.assertEqual(len(installer.validate(cfg)['employees']),1)
        cfg['employees'].append(dict(cfg['employees'][0],key='finance',linuxUser='xa-finance',agentId='33333333-3333-3333-3333-333333333333'))
        with self.assertRaises(SystemExit):installer.validate(cfg)
if __name__=='__main__':unittest.main()
