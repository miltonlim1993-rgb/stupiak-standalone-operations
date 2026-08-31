import { CameraView, useCameraPermissions } from 'expo-camera';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Modal,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { localCatalog } from './src/data/catalogSource';
import { demoBatches } from './src/data/demoSeed';
import { LocalLabelBackend } from './src/data/localBackend';
import { eligibleSources, validateSource } from './src/domain/engine';
import { LabelBatch } from './src/domain/types';
import { MockPrinter } from './src/printing/mockPrinter';
import { NativeTcpPrinter } from './src/printing/nativeTcpPrinter';
import { StableV2TsplBuilder } from './src/printing/tspl';
import { executePrintWorkflow } from './src/workflow/printWorkflow';

const C = {
  primary: '#F2AA00',
  ink: '#111111',
  muted: '#667085',
  border: '#E5E7EB',
  bg: '#F5F5F3',
  surface: '#FFFFFF',
  green: '#18794E',
  red: '#C4320A',
  amberBg: '#FFF7DF',
};

type Tab = 'print' | 'stock' | 'settings';
type ScanMode = 'source' | 'stock' | null;
type PrinterMode = 'dry-run' | 'direct-wifi';

const backend = new LocalLabelBackend();
const tsplBuilder = new StableV2TsplBuilder();
const dryPrinter = new MockPrinter();
const wifiPrinter = new NativeTcpPrinter();
const DEFAULT_PRODUCT = 'slice-cheese-rv';
const DEFAULT_RULE = 'slice-cheese-rv-received-chiller';

const fmt = (value?: string) => {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString([], {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
};

function Card({ title, children }: { title?: string; children: React.ReactNode }) {
  return <View style={styles.card}>{title ? <Text style={styles.cardTitle}>{title}</Text> : null}{children}</View>;
}

function Option({ title, subtitle, selected, onPress }: {
  title: string; subtitle?: string; selected?: boolean; onPress: () => void;
}) {
  return (
    <Pressable style={[styles.option, selected && styles.optionSelected]} onPress={onPress}>
      <View style={styles.flex}>
        <Text style={styles.optionTitle}>{title}</Text>
        {subtitle ? <Text style={styles.small}>{subtitle}</Text> : null}
      </View>
      <Text style={styles.optionMark}>{selected ? '✓' : '›'}</Text>
    </Pressable>
  );
}

function BatchCard({ batch }: { batch: LabelBatch }) {
  const tracked = batch.initialQuantity > 0;
  return (
    <View style={styles.batch}>
      <View style={styles.rowBetween}>
        <View style={styles.flex}>
          <Text style={styles.batchTitle}>{batch.productName}</Text>
          <Text style={styles.small}>{batch.action} · {batch.storageCondition}</Text>
        </View>
        <View style={[styles.pill, batch.status === 'active' ? styles.pillGood : styles.pillBad]}>
          <Text style={[styles.pillText, { color: batch.status === 'active' ? C.green : C.red }]}>{batch.status.toUpperCase()}</Text>
        </View>
      </View>
      <View style={styles.metricRow}>
        <View style={styles.metric}>
          <Text style={styles.metricKey}>{tracked ? 'SOURCE REMAINING' : 'SOURCE CAPACITY'}</Text>
          <Text style={styles.metricValue}>{tracked ? `${batch.remainingQuantity} / ${batch.initialQuantity} ${batch.quantityUnit}` : 'Terminal / N.A.'}</Text>
        </View>
        <View style={styles.metric}>
          <Text style={styles.metricKey}>USE BY</Text>
          <Text style={styles.metricValue}>{fmt(batch.expiryAt)}</Text>
        </View>
      </View>
      {batch.contentQuantity !== undefined ? <Text style={styles.small}>Content: {batch.contentQuantity} {batch.contentQuantityUnit || ''}</Text> : null}
      <Text style={styles.mono}>{batch.batchId}</Text>
      {batch.sourceBatchId ? <Text style={styles.small}>Source: {batch.sourceBatchId}</Text> : null}
    </View>
  );
}

export default function AppV3() {
  const [tab, setTab] = useState<Tab>('print');
  const [batches, setBatches] = useState<LabelBatch[]>(demoBatches);
  const [productId, setProductId] = useState(DEFAULT_PRODUCT);
  const [ruleId, setRuleId] = useState(DEFAULT_RULE);
  const [productSearch, setProductSearch] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [printQuantity, setPrintQuantity] = useState('1');
  const [manualExpiry, setManualExpiry] = useState('');
  const [source, setSource] = useState<LabelBatch | undefined>();
  const [inspected, setInspected] = useState<LabelBatch | undefined>();
  const [scanMode, setScanMode] = useState<ScanMode>(null);
  const [scanBusy, setScanBusy] = useState(false);
  const [permission, requestPermission] = useCameraPermissions();
  const [outlet, setOutlet] = useState('RR-KCH');
  const [staff, setStaff] = useState('');
  const [printerMode, setPrinterMode] = useState<PrinterMode>('dry-run');
  const [printerHost, setPrinterHost] = useState('192.168.0.211');
  const [printerPort, setPrinterPort] = useState('9100');
  const [printing, setPrinting] = useState(false);

  const products = localCatalog.products;
  const product = useMemo(() => products.find((item) => item.productId === productId) || null, [productId, products]);
  const productRules = useMemo(
    () => localCatalog.rules
      .filter((item) => item.enabled && item.productId === productId)
      .sort((a, b) => Number(a.sourceTier || 0) - Number(b.sourceTier || 0) || String(a.action).localeCompare(String(b.action))),
    [productId],
  );
  const rule = useMemo(() => productRules.find((item) => item.id === ruleId) || productRules[0] || null, [productRules, ruleId]);
  const visibleProducts = useMemo(() => {
    const q = productSearch.trim().toLowerCase();
    const matches = q ? products.filter((item) => `${item.productName} ${item.category || ''}`.toLowerCase().includes(q)) : products;
    return matches.slice(0, 14);
  }, [productSearch, products]);
  const availableSources = useMemo(() => rule?.requiresSource ? eligibleSources(batches, rule, outlet) : [], [batches, outlet, rule]);
  const fifo = availableSources[0];

  const refresh = async () => setBatches(await backend.listBatches(outlet));
  useEffect(() => { refresh().catch(() => undefined); }, [outlet]);

  const openScanner = async (mode: Exclude<ScanMode, null>) => {
    if (!permission?.granted) {
      const next = await requestPermission();
      if (!next.granted) {
        Alert.alert('Camera required', 'Allow camera access to scan printed label barcodes.');
        return;
      }
    }
    setScanBusy(false);
    setScanMode(mode);
  };

  const onScanned = async (raw: string) => {
    if (scanBusy) return;
    setScanBusy(true);
    const found = await backend.lookupBatch(raw, outlet);
    if (!found) {
      Alert.alert('Label not found', raw);
      setScanBusy(false);
      return;
    }
    if (scanMode === 'stock') {
      setInspected(found);
      setScanMode(null);
      return;
    }
    if (scanMode === 'source' && rule) {
      const latest = await backend.listBatches(outlet);
      setBatches(latest);
      const validation = validateSource(found, latest, rule, outlet);
      if (!validation.ok) {
        Alert.alert('Cannot use this source', `${validation.message || validation.reason || 'Invalid source'}${validation.fifoBatchId ? `\n\nUse oldest batch: ${validation.fifoBatchId}` : ''}`);
        setScanBusy(false);
        return;
      }
      setSource(found);
      setScanMode(null);
    }
  };

  const print = async () => {
    if (!product || !rule) return;
    if (!staff.trim()) {
      Alert.alert('Staff name required', 'Set the staff name under Settings.');
      return;
    }
    const contentQty = Number(quantity || 0);
    if (rule.requiresQuantity && (!Number.isFinite(contentQty) || contentQty <= 0)) {
      Alert.alert('Invalid quantity', 'Enter a valid product quantity or weight.');
      return;
    }
    const copies = Number(printQuantity || 0);
    if (!Number.isInteger(copies) || copies < 1 || copies > 100) {
      Alert.alert('Invalid label count', 'Labels to Print must be a whole number from 1 to 100.');
      return;
    }
    if (rule.requiresSource && !source) {
      Alert.alert('Source required', 'Scan the old label or choose the FIFO source first.');
      return;
    }

    setPrinting(true);
    try {
      const latest = await backend.listBatches(outlet);
      setBatches(latest);
      const result = await executePrintWorkflow({
        request: {
          outletName: outlet,
          staffName: staff.trim(),
          product,
          rule,
          quantity: rule.requiresQuantity ? contentQty : 1,
          printQuantity: copies,
          sourceBatch: source,
          madeAt: new Date().toISOString(),
          manualExpiryAt: rule.manualExpiryRequired ? manualExpiry.trim() : undefined,
        },
        copies,
        allBatches: latest,
        backend,
        printer: printerMode === 'direct-wifi' ? wifiPrinter : dryPrinter,
        tspl: tsplBuilder,
        printerTarget: { host: printerHost.trim() || 'mock-printer', port: Math.max(1, Number(printerPort || 9100)) },
      });

      await refresh();
      if (!result.printed) {
        Alert.alert('Print failed', result.error || 'Unknown printer error. Source reservation was rolled back.');
        return;
      }
      setSource(undefined);
      Alert.alert(
        printerMode === 'direct-wifi' ? 'Label printed' : 'Closed-loop test passed',
        `${result.batch.productName}\n${result.batch.action}\n${result.batch.batchId}\nLabels: ${copies}${printerMode === 'dry-run' ? '\n\nNo physical print and no GAS call.' : ''}`,
      );
    } catch (error) {
      Alert.alert('Blocked', error instanceof Error ? error.message : String(error));
    } finally {
      setPrinting(false);
    }
  };

  const testPrinter = async () => {
    const result = await wifiPrinter.testConnection?.({ host: printerHost.trim(), port: Math.max(1, Number(printerPort || 9100)) });
    Alert.alert(result?.ok ? 'Printer reachable' : 'Printer unavailable', result?.ok ? `${printerHost}:${printerPort}` : result?.error || 'Connection failed.');
  };

  const resetLedger = () => Alert.alert(
    'Reset local test ledger?',
    'This only clears V2 Beta local batches and restores the demo Received 40 source. GAS and production data are not touched.',
    [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Reset', style: 'destructive', onPress: async () => { await backend.resetLocalLedger(); await refresh(); setSource(undefined); setInspected(undefined); } },
    ],
  );

  const PrintTab = () => (
    <>
      <View style={styles.banner}>
        <Text style={styles.bannerTitle}>V2 BETA · READ-ONLY SHEET SNAPSHOT</Text>
        <Text style={styles.bannerText}>{products.length} products · {localCatalog.rules.length} enabled rules · GAS frozen · local ledger persistent.</Text>
      </View>

      <Card title="1 · Product">
        <TextInput style={styles.input} value={productSearch} onChangeText={setProductSearch} placeholder="Search product" />
        {visibleProducts.map((item) => (
          <Option key={item.productId} title={item.displayName || item.productName} subtitle={item.category} selected={item.productId === productId}
            onPress={() => { setProductId(item.productId); setRuleId(''); setSource(undefined); setProductSearch(''); }} />
        ))}
        {products.length > visibleProducts.length && !productSearch ? <Text style={styles.small}>Search to access the remaining products.</Text> : null}
      </Card>

      <Card title="2 · Action">
        {productRules.map((item) => (
          <Option key={item.id} title={item.action}
            subtitle={`${item.storageCondition}${item.requiresSource ? ` · source Tier ${item.requiredSourceTier || '?'}` : ''}`}
            selected={item.id === rule?.id} onPress={() => { setRuleId(item.id); setSource(undefined); setManualExpiry(''); }} />
        ))}
      </Card>

      {rule?.requiresQuantity ? (
        <Card title="3 · Product Quantity / Weight">
          <TextInput style={styles.input} value={quantity} onChangeText={setQuantity} keyboardType="decimal-pad" />
          <Text style={styles.small}>{rule.quantityLabel || 'Quantity'} · {rule.quantityUnit || 'unit'} · this is NOT label count.</Text>
        </Card>
      ) : null}

      {rule?.manualExpiryRequired ? (
        <Card title={`${rule.requiresQuantity ? '4' : '3'} · Manual Use By`}>
          <TextInput style={styles.input} value={manualExpiry} onChangeText={setManualExpiry} placeholder="2026-09-01T18:00:00+08:00" autoCapitalize="none" />
          <Text style={styles.small}>Required by this ExpiryRules row. Must be later than Made time.</Text>
        </Card>
      ) : null}

      <Card title={`${2 + (rule?.requiresQuantity ? 1 : 0) + (rule?.manualExpiryRequired ? 1 : 0) + 1} · Labels to Print`}>
        <TextInput style={styles.input} value={printQuantity} onChangeText={setPrintQuantity} keyboardType="number-pad" />
        <Text style={styles.small}>Physical labels, 1–100. Tier 1/2 source capacity equals this count. Child source deduction = labels × consumePerLabel.</Text>
      </Card>

      {rule?.requiresSource ? (
        <Card title="Source · FIFO enforced">
          {source ? (
            <><BatchCard batch={source} /><Pressable style={styles.secondary} onPress={() => setSource(undefined)}><Text style={styles.secondaryText}>Change source</Text></Pressable></>
          ) : (
            <>
              <Pressable style={styles.darkButton} onPress={() => openScanner('source')}><Text style={styles.darkButtonText}>▣  Scan Source Label</Text></Pressable>
              {fifo ? <><Text style={styles.fifoLabel}>FIFO · OLDEST ELIGIBLE</Text><BatchCard batch={fifo} /><Pressable style={styles.secondary} onPress={() => setSource(fifo)}><Text style={styles.secondaryText}>Use this batch</Text></Pressable></>
                : <Text style={styles.blocked}>No eligible source stock. This action is blocked.</Text>}
            </>
          )}
        </Card>
      ) : null}

      <Card title="Review & print">
        <View style={styles.review}><Text style={styles.reviewKey}>Product</Text><Text style={styles.reviewValue}>{product?.displayName || '-'}</Text></View>
        <View style={styles.review}><Text style={styles.reviewKey}>Action</Text><Text style={styles.reviewValue}>{rule ? `${rule.action} · ${rule.storageCondition}` : '-'}</Text></View>
        {rule?.requiresQuantity ? <View style={styles.review}><Text style={styles.reviewKey}>Content qty</Text><Text style={styles.reviewValue}>{quantity} {rule.quantityUnit || ''}</Text></View> : null}
        <View style={styles.review}><Text style={styles.reviewKey}>Labels</Text><Text style={styles.reviewValue}>{printQuantity}</Text></View>
        <View style={styles.review}><Text style={styles.reviewKey}>Source</Text><Text style={styles.reviewValue}>{rule?.requiresSource ? source?.batchId || 'Required' : 'None'}</Text></View>
        <View style={styles.review}><Text style={styles.reviewKey}>Mode</Text><Text style={styles.reviewValue}>{printerMode === 'dry-run' ? 'Dry run' : `Direct ${printerHost}:${printerPort}`}</Text></View>
        <Pressable disabled={printing} onPress={print} style={[styles.primaryButton, printing && styles.disabled]}>
          <Text style={styles.primaryButtonText}>{printing ? 'Working…' : printerMode === 'dry-run' ? 'Validate Closed Loop' : 'Print Labels'}</Text>
        </Pressable>
      </Card>
    </>
  );

  const StockTab = () => (
    <>
      <Card>
        <Text style={styles.heroTitle}>Check old stock</Text>
        <Text style={styles.heroText}>Scan a V2 label to inspect source remaining, expiry and genealogy from the persistent local ledger.</Text>
        <Pressable style={styles.darkButton} onPress={() => openScanner('stock')}><Text style={styles.darkButtonText}>▣  Scan Label</Text></Pressable>
      </Card>
      {inspected ? <BatchCard batch={inspected} /> : null}
      <Card title={`Active batches · ${batches.filter((item) => item.status === 'active').length}`}>
        {batches.filter((item) => item.status === 'active').map((item) => <BatchCard batch={item} key={item.batchId} />)}
      </Card>
    </>
  );

  const SettingsTab = () => (
    <>
      <Card title="Outlet & staff">
        <Text style={styles.fieldLabel}>Outlet</Text><TextInput style={styles.input} value={outlet} onChangeText={setOutlet} autoCapitalize="characters" />
        <Text style={styles.fieldLabel}>Staff name</Text><TextInput style={styles.input} value={staff} onChangeText={setStaff} placeholder="Staff name" />
      </Card>
      <Card title="Printer">
        <Option title="Dry run" subtitle="Full local reserve/commit, no physical print" selected={printerMode === 'dry-run'} onPress={() => setPrinterMode('dry-run')} />
        <Option title="Direct WiFi" subtitle="Stable raw TSPL over TCP 9100" selected={printerMode === 'direct-wifi'} onPress={() => setPrinterMode('direct-wifi')} />
        <Text style={styles.fieldLabel}>Printer IP</Text><TextInput style={styles.input} value={printerHost} onChangeText={setPrinterHost} keyboardType="numbers-and-punctuation" />
        <Text style={styles.fieldLabel}>Port</Text><TextInput style={styles.input} value={printerPort} onChangeText={setPrinterPort} keyboardType="number-pad" />
        <Pressable style={styles.secondary} onPress={testPrinter}><Text style={styles.secondaryText}>Test printer connection</Text></Pressable>
      </Card>
      <Card title="Data isolation">
        <Text style={styles.good}>● Persistent V2 local ledger active</Text>
        <Text style={styles.small}>● Embedded Sheet snapshot: {localCatalog.capturedAt}</Text>
        <Text style={styles.small}>● Runtime hierarchy: {localCatalog.runtimePolicyVersion}</Text>
        <Text style={styles.small}>○ GAS V2 not connected</Text>
        <Text style={styles.small}>○ Production GAS / APK untouched</Text>
        <Pressable style={styles.secondary} onPress={resetLedger}><Text style={styles.secondaryText}>Reset local Beta ledger</Text></Pressable>
      </Card>
    </>
  );

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar style="dark" />
      <View style={styles.header}><View><Text style={styles.title}>SP Label Printing V2</Text><Text style={styles.small}>{outlet}</Text></View><View style={styles.beta}><Text style={styles.betaText}>BETA</Text></View></View>
      <View style={styles.tabs}>{(['print','stock','settings'] as Tab[]).map((item) => <Pressable key={item} onPress={() => setTab(item)} style={[styles.tab, tab === item && styles.tabSelected]}><Text style={[styles.tabText, tab === item && styles.tabTextSelected]}>{item === 'print' ? 'Print' : item === 'stock' ? 'Check Stock' : 'Settings'}</Text></Pressable>)}</View>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">{tab === 'print' ? <PrintTab /> : tab === 'stock' ? <StockTab /> : <SettingsTab />}</ScrollView>
      <Modal visible={scanMode !== null} animationType="slide" onRequestClose={() => setScanMode(null)}>
        <SafeAreaView style={styles.scanner}>
          <View style={styles.scannerHeader}><View><Text style={styles.scannerTitle}>{scanMode === 'source' ? 'Scan source label' : 'Check stock'}</Text><Text style={styles.small}>CODE128 / LBL barcode</Text></View><Pressable onPress={() => setScanMode(null)}><Text style={styles.closeText}>Close</Text></Pressable></View>
          <View style={styles.camera}><CameraView style={StyleSheet.absoluteFill} barcodeScannerSettings={{ barcodeTypes: ['code128','qr'] }} onBarcodeScanned={({ data }) => onScanned(String(data || ''))} /><View style={styles.scanBox} /></View>
          <Text style={styles.scanHint}>LBL:&lt;batch id&gt;</Text>
        </SafeAreaView>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe:{flex:1,backgroundColor:C.bg},flex:{flex:1},header:{flexDirection:'row',alignItems:'center',justifyContent:'space-between',paddingHorizontal:16,paddingVertical:12,backgroundColor:C.surface,borderBottomWidth:1,borderBottomColor:C.border},title:{fontSize:20,fontWeight:'800',color:C.ink},beta:{backgroundColor:'#FFF0BE',borderRadius:999,paddingHorizontal:10,paddingVertical:5},betaText:{color:'#755000',fontWeight:'900',fontSize:10},tabs:{flexDirection:'row',backgroundColor:C.surface,borderBottomWidth:1,borderBottomColor:C.border},tab:{flex:1,alignItems:'center',paddingVertical:12,borderBottomWidth:3,borderBottomColor:'transparent'},tabSelected:{borderBottomColor:C.primary},tabText:{color:C.muted,fontSize:13,fontWeight:'700'},tabTextSelected:{color:C.ink},content:{padding:13,paddingBottom:42,gap:12},banner:{borderWidth:1,borderColor:'#F2D271',backgroundColor:C.amberBg,borderRadius:14,padding:13},bannerTitle:{color:'#6B4900',fontWeight:'900',fontSize:11,letterSpacing:0.8},bannerText:{color:'#6B4900',fontSize:12,lineHeight:17,marginTop:4},card:{backgroundColor:C.surface,borderWidth:1,borderColor:C.border,borderRadius:15,padding:13,gap:9},cardTitle:{color:C.ink,fontSize:14,fontWeight:'800'},option:{minHeight:52,borderWidth:1,borderColor:C.border,borderRadius:11,paddingHorizontal:12,paddingVertical:9,flexDirection:'row',alignItems:'center'},optionSelected:{borderColor:C.primary,backgroundColor:'#FFFAEA'},optionTitle:{color:C.ink,fontSize:14,fontWeight:'700'},optionMark:{marginLeft:8,color:C.ink,fontSize:18,fontWeight:'800'},small:{color:C.muted,fontSize:11,lineHeight:16},input:{minHeight:47,borderWidth:1,borderColor:C.border,borderRadius:11,paddingHorizontal:12,backgroundColor:C.surface,color:C.ink,fontSize:14},fieldLabel:{color:C.muted,fontSize:11,fontWeight:'700',marginTop:2},darkButton:{minHeight:49,borderRadius:11,backgroundColor:C.ink,alignItems:'center',justifyContent:'center'},darkButtonText:{color:'#FFF',fontWeight:'800',fontSize:14},primaryButton:{minHeight:52,borderRadius:12,backgroundColor:C.primary,alignItems:'center',justifyContent:'center',marginTop:5},primaryButtonText:{color:C.ink,fontWeight:'900',fontSize:14},secondary:{minHeight:45,borderRadius:11,borderWidth:1,borderColor:C.ink,alignItems:'center',justifyContent:'center',paddingHorizontal:12},secondaryText:{color:C.ink,fontWeight:'800',fontSize:12},disabled:{opacity:0.5},fifoLabel:{textAlign:'center',color:C.muted,fontSize:9,fontWeight:'900',letterSpacing:1.1},blocked:{color:C.red,backgroundColor:'#FFF0EB',borderRadius:10,padding:11,fontSize:12,lineHeight:17},batch:{borderWidth:1,borderColor:C.border,borderRadius:12,padding:11,backgroundColor:'#FCFCFC',gap:7},rowBetween:{flexDirection:'row',alignItems:'flex-start',justifyContent:'space-between',gap:8},batchTitle:{color:C.ink,fontSize:14,fontWeight:'800'},pill:{borderRadius:999,paddingHorizontal:7,paddingVertical:4},pillGood:{backgroundColor:'#E7F5ED'},pillBad:{backgroundColor:'#FFF0EB'},pillText:{fontSize:8,fontWeight:'900'},metricRow:{flexDirection:'row',gap:7},metric:{flex:1,borderWidth:1,borderColor:'#ECEDEF',backgroundColor:'#FFF',borderRadius:9,padding:8},metricKey:{color:C.muted,fontSize:8,fontWeight:'800'},metricValue:{color:C.ink,fontSize:11,fontWeight:'700',marginTop:3},mono:{color:C.ink,fontSize:10,fontWeight:'700'},review:{flexDirection:'row',justifyContent:'space-between',gap:10,paddingVertical:2},reviewKey:{color:C.muted,fontSize:11},reviewValue:{flex:1,textAlign:'right',color:C.ink,fontSize:11,fontWeight:'700'},heroTitle:{color:C.ink,fontSize:21,fontWeight:'800'},heroText:{color:C.muted,fontSize:12,lineHeight:18},good:{color:C.green,fontSize:12,fontWeight:'700'},scanner:{flex:1,backgroundColor:'#111'},scannerHeader:{backgroundColor:'#FFF',padding:14,flexDirection:'row',justifyContent:'space-between',alignItems:'center'},scannerTitle:{color:C.ink,fontSize:18,fontWeight:'800'},closeText:{color:C.ink,fontSize:13,fontWeight:'800'},camera:{flex:1,overflow:'hidden'},scanBox:{position:'absolute',left:'10%',right:'10%',top:'38%',height:150,borderWidth:3,borderColor:C.primary,borderRadius:16},scanHint:{color:'#FFF',fontSize:11,textAlign:'center',padding:14},
});
