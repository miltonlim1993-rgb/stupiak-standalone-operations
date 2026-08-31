import { CameraView, useCameraPermissions } from 'expo-camera';
import { StatusBar } from 'expo-status-bar';
import { useMemo, useRef, useState } from 'react';
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

import { eligibleSources, validateSource } from './src/domain/engine';
import { ExpiryRule, LabelBatch, ProductMaster } from './src/domain/types';
import { MockLabelBackend } from './src/data/mockBackend';
import { demoBatches, demoProducts, demoRules } from './src/data/demoSeed';

const PRIMARY = '#F2AA00';
const INK = '#111111';
const MUTED = '#667085';
const BORDER = '#E6E8EC';
const BG = '#F7F7F6';
const GOOD = '#18794E';
const BAD = '#C4320A';

type Mode = 'print' | 'stock' | 'settings';
type ScannerPurpose = 'source' | 'stock' | null;

const backend = new MockLabelBackend({
  products: demoProducts,
  rules: demoRules,
  batches: demoBatches,
});

const fmt = (iso?: string) => {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString([], {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
};

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

function Choice({
  title,
  subtitle,
  selected,
  onPress,
}: {
  title: string;
  subtitle?: string;
  selected?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable onPress={onPress} style={[styles.choice, selected && styles.choiceSelected]}>
      <View style={{ flex: 1 }}>
        <Text style={styles.choiceTitle}>{title}</Text>
        {subtitle ? <Text style={styles.choiceSubtitle}>{subtitle}</Text> : null}
      </View>
      <Text style={styles.chevron}>{selected ? '✓' : '›'}</Text>
    </Pressable>
  );
}

function BatchCard({ batch, compact = false }: { batch: LabelBatch; compact?: boolean }) {
  const remainingLabel = `${batch.remainingQuantity} / ${batch.initialQuantity} ${batch.quantityUnit || ''}`.trim();
  return (
    <View style={styles.batchCard}>
      <View style={styles.batchHeader}>
        <View style={{ flex: 1 }}>
          <Text style={styles.batchProduct}>{batch.productName}</Text>
          <Text style={styles.batchAction}>{batch.action} · {batch.storageCondition}</Text>
        </View>
        <View style={[styles.statusPill, batch.status === 'active' ? styles.statusGood : styles.statusBad]}>
          <Text style={[styles.statusText, batch.status === 'active' ? { color: GOOD } : { color: BAD }]}>{batch.status.toUpperCase()}</Text>
        </View>
      </View>
      <View style={styles.metricRow}>
        <View style={styles.metric}>
          <Text style={styles.metricLabel}>REMAINING</Text>
          <Text style={styles.metricValue}>{remainingLabel}</Text>
        </View>
        <View style={styles.metric}>
          <Text style={styles.metricLabel}>USE BY</Text>
          <Text style={styles.metricValue}>{fmt(batch.expiryAt)}</Text>
        </View>
      </View>
      {!compact ? (
        <>
          <Text style={styles.detail}>Batch: {batch.batchId}</Text>
          <Text style={styles.detail}>Made: {fmt(batch.madeAt)}</Text>
          {batch.sourceBatchId ? <Text style={styles.detail}>Source: {batch.sourceBatchId}</Text> : null}
        </>
      ) : null}
    </View>
  );
}

export default function App() {
  const [mode, setMode] = useState<Mode>('print');
  const [products] = useState<ProductMaster[]>(demoProducts);
  const [rules] = useState<ExpiryRule[]>(demoRules);
  const [batches, setBatches] = useState<LabelBatch[]>(demoBatches);
  const [productId, setProductId] = useState(demoProducts[0]?.productId || '');
  const [ruleId, setRuleId] = useState('');
  const [quantity, setQuantity] = useState('40');
  const [sourceBatch, setSourceBatch] = useState<LabelBatch | undefined>();
  const [stockBatch, setStockBatch] = useState<LabelBatch | undefined>();
  const [outletName, setOutletName] = useState('RR-KCH');
  const [staffName, setStaffName] = useState('');
  const [printerHost, setPrinterHost] = useState('192.168.0.211');
  const [printerPort, setPrinterPort] = useState('9100');
  const [scannerPurpose, setScannerPurpose] = useState<ScannerPurpose>(null);
  const [scannerLocked, setScannerLocked] = useState(false);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const scannerResetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const product = useMemo(
    () => products.find((item) => item.productId === productId) || null,
    [productId, products],
  );
  const productRules = useMemo(
    () => rules.filter((item) => item.enabled && item.productId === productId),
    [productId, rules],
  );
  const rule = useMemo(
    () => productRules.find((item) => item.id === ruleId) || productRules[0] || null,
    [productRules, ruleId],
  );
  const sources = useMemo(
    () => (rule?.requiresSource ? eligibleSources(batches, rule, outletName) : []),
    [batches, outletName, rule],
  );
  const fifoSource = sources[0];

  const refreshBatches = async () => {
    setBatches(await backend.listBatches(outletName));
  };

  const openScanner = async (purpose: Exclude<ScannerPurpose, null>) => {
    if (!cameraPermission?.granted) {
      const result = await requestCameraPermission();
      if (!result.granted) {
        Alert.alert('Camera permission required', 'Camera access is needed to scan printed food labels.');
        return;
      }
    }
    setScannerLocked(false);
    setScannerPurpose(purpose);
  };

  const handleBarcode = async (code: string) => {
    if (scannerLocked) return;
    setScannerLocked(true);
    const found = await backend.lookupBatch(code, outletName);
    if (!found) {
      Alert.alert('Label not found', code);
      scannerResetTimer.current = setTimeout(() => setScannerLocked(false), 800);
      return;
    }

    if (scannerPurpose === 'stock') {
      setStockBatch(found);
      setScannerPurpose(null);
      return;
    }

    if (scannerPurpose === 'source' && rule) {
      const result = validateSource(found, batches, rule, outletName);
      if (!result.ok) {
        const suffix = result.fifoBatchId ? `\nOldest eligible: ${result.fifoBatchId}` : '';
        Alert.alert('Cannot use this source', `${result.message || result.reason}${suffix}`);
        scannerResetTimer.current = setTimeout(() => setScannerLocked(false), 800);
        return;
      }
      setSourceBatch(found);
      setScannerPurpose(null);
    }
  };

  const simulatePrint = async () => {
    if (!product || !rule) {
      Alert.alert('Select a product and action first.');
      return;
    }
    if (!staffName.trim()) {
      Alert.alert('Staff name required', 'Enter the staff name in Settings first.');
      return;
    }
    if (rule.requiresSource && !sourceBatch) {
      Alert.alert('Source required', 'Scan the old label or use the oldest eligible stock.');
      return;
    }

    try {
      const source = sourceBatch;
      const madeAt = new Date().toISOString();
      const draft = await import('./src/domain/engine').then(({ createDraftLabel }) =>
        createDraftLabel(
          {
            outletName,
            staffName: staffName.trim(),
            product,
            rule,
            quantity: Math.max(1, Number(quantity || 1)),
            sourceBatch: source,
            madeAt,
          },
          batches,
        ),
      );
      const pending = await backend.reserveDraft(draft);
      const committed = await backend.commitPrinted(pending.batchId, new Date().toISOString(), printerHost);
      await refreshBatches();
      setSourceBatch(undefined);
      Alert.alert(
        'V2 local flow passed',
        `${committed.productName}\n${committed.action}\n${committed.batchId}\n\nNo GAS call was made.`,
      );
    } catch (error) {
      Alert.alert('Blocked', error instanceof Error ? error.message : String(error));
    }
  };

  const renderPrint = () => (
    <>
      <View style={styles.betaBanner}>
        <Text style={styles.betaTitle}>V2 BETA · LOCAL CLOSED LOOP</Text>
        <Text style={styles.betaBody}>GAS is frozen. This build validates mobile workflow, source quantity, FIFO and scanning locally.</Text>
      </View>

      <Section title="1 · Product">
        {products.map((item) => (
          <Choice
            key={item.productId}
            title={item.displayName || item.productName}
            subtitle={item.category}
            selected={item.productId === productId}
            onPress={() => {
              setProductId(item.productId);
              setRuleId('');
              setSourceBatch(undefined);
            }}
          />
        ))}
      </Section>

      <Section title="2 · Action">
        {productRules.map((item) => (
          <Choice
            key={item.id}
            title={item.action}
            subtitle={`${item.storageCondition}${item.requiresSource ? ' · source required' : ''}`}
            selected={rule?.id === item.id}
            onPress={() => {
              setRuleId(item.id);
              setSourceBatch(undefined);
            }}
          />
        ))}
      </Section>

      {rule?.requiresQuantity ? (
        <Section title="3 · Quantity">
          <TextInput
            value={quantity}
            onChangeText={setQuantity}
            keyboardType="decimal-pad"
            placeholder="Quantity"
            style={styles.input}
          />
          <Text style={styles.helper}>{rule.quantityLabel || 'Quantity'} · {rule.quantityUnit || 'unit'}</Text>
        </Section>
      ) : null}

      {rule?.requiresSource ? (
        <Section title={`${rule.requiresQuantity ? '4' : '3'} · Source stock`}>
          {sourceBatch ? (
            <>
              <BatchCard batch={sourceBatch} />
              <Pressable style={styles.secondaryButton} onPress={() => setSourceBatch(undefined)}>
                <Text style={styles.secondaryText}>Change source</Text>
              </Pressable>
            </>
          ) : (
            <>
              <Pressable style={styles.scanButton} onPress={() => openScanner('source')}>
                <Text style={styles.scanButtonText}>▣  Scan Source Label</Text>
              </Pressable>
              {fifoSource ? (
                <>
                  <Text style={styles.or}>OR USE FIFO</Text>
                  <BatchCard batch={fifoSource} compact />
                  <Pressable style={styles.secondaryButton} onPress={() => setSourceBatch(fifoSource)}>
                    <Text style={styles.secondaryText}>Use oldest eligible batch</Text>
                  </Pressable>
                </>
              ) : (
                <View style={styles.warningBox}>
                  <Text style={styles.warningTitle}>No eligible source stock</Text>
                  <Text style={styles.warningText}>This action cannot continue until an eligible source batch exists.</Text>
                </View>
              )}
            </>
          )}
        </Section>
      ) : null}

      <Section title="Review">
        <View style={styles.reviewRow}><Text style={styles.reviewKey}>Product</Text><Text style={styles.reviewValue}>{product?.displayName || '-'}</Text></View>
        <View style={styles.reviewRow}><Text style={styles.reviewKey}>Action</Text><Text style={styles.reviewValue}>{rule ? `${rule.action} · ${rule.storageCondition}` : '-'}</Text></View>
        <View style={styles.reviewRow}><Text style={styles.reviewKey}>Source</Text><Text style={styles.reviewValue}>{rule?.requiresSource ? sourceBatch?.batchId || 'Required' : 'Not required'}</Text></View>
        <View style={styles.reviewRow}><Text style={styles.reviewKey}>Printer</Text><Text style={styles.reviewValue}>{printerHost}:{printerPort}</Text></View>
        <Pressable style={styles.primaryButton} onPress={simulatePrint}>
          <Text style={styles.primaryText}>Validate & Create Label</Text>
        </Pressable>
        <Text style={styles.helperCenter}>Development mode: reserves/consumes locally; physical printer call is not enabled on this screen yet.</Text>
      </Section>
    </>
  );

  const renderStock = () => (
    <>
      <View style={styles.hero}>
        <Text style={styles.heroTitle}>Check old stock</Text>
        <Text style={styles.heroBody}>Scan a printed label to see its batch identity, remaining source quantity and traceability.</Text>
        <Pressable style={styles.scanButton} onPress={() => openScanner('stock')}>
          <Text style={styles.scanButtonText}>▣  Scan Label Barcode</Text>
        </Pressable>
      </View>
      {stockBatch ? <BatchCard batch={stockBatch} /> : null}
      <Section title="Active source batches">
        {batches.filter((item) => item.status === 'active').map((item) => <BatchCard key={item.batchId} batch={item} compact />)}
      </Section>
    </>
  );

  const renderSettings = () => (
    <>
      <Section title="Outlet & staff">
        <Text style={styles.label}>Outlet</Text>
        <TextInput value={outletName} onChangeText={setOutletName} style={styles.input} autoCapitalize="characters" />
        <Text style={styles.label}>Staff name</Text>
        <TextInput value={staffName} onChangeText={setStaffName} style={styles.input} placeholder="Name" />
      </Section>
      <Section title="Printer">
        <Text style={styles.label}>Printer IP</Text>
        <TextInput value={printerHost} onChangeText={setPrinterHost} style={styles.input} keyboardType="numbers-and-punctuation" />
        <Text style={styles.label}>Port</Text>
        <TextInput value={printerPort} onChangeText={setPrinterPort} style={styles.input} keyboardType="number-pad" />
        <Text style={styles.helper}>V2 will reuse the stable raw TSPL TCP transport. Current production app is not modified.</Text>
      </Section>
      <Section title="Backend status">
        <View style={styles.statusLine}><Text style={styles.statusDot}>●</Text><Text style={styles.statusLineText}>Local mock backend active</Text></View>
        <View style={styles.statusLine}><Text style={[styles.statusDot, { color: MUTED }]}>●</Text><Text style={styles.statusLineText}>GAS V2 not connected</Text></View>
        <Text style={styles.helper}>This is deliberate for the APK/domain phase.</Text>
      </Section>
    </>
  );

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar style="dark" />
      <View style={styles.header}>
        <View>
          <Text style={styles.appName}>SP Label Printing V2</Text>
          <Text style={styles.headerSub}>{outletName}</Text>
        </View>
        <View style={styles.betaPill}><Text style={styles.betaPillText}>BETA</Text></View>
      </View>
      <View style={styles.tabs}>
        {(['print', 'stock', 'settings'] as Mode[]).map((item) => (
          <Pressable key={item} onPress={() => setMode(item)} style={[styles.tab, mode === item && styles.tabActive]}>
            <Text style={[styles.tabText, mode === item && styles.tabTextActive]}>{item === 'print' ? 'Print' : item === 'stock' ? 'Check Stock' : 'Settings'}</Text>
          </Pressable>
        ))}
      </View>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {mode === 'print' ? renderPrint() : mode === 'stock' ? renderStock() : renderSettings()}
      </ScrollView>

      <Modal visible={scannerPurpose !== null} animationType="slide" onRequestClose={() => setScannerPurpose(null)}>
        <SafeAreaView style={styles.scannerPage}>
          <View style={styles.scannerTop}>
            <View>
              <Text style={styles.scannerTitle}>{scannerPurpose === 'source' ? 'Scan source label' : 'Check stock'}</Text>
              <Text style={styles.scannerSub}>Point at the CODE128 / LBL barcode.</Text>
            </View>
            <Pressable onPress={() => setScannerPurpose(null)}><Text style={styles.close}>Close</Text></Pressable>
          </View>
          <View style={styles.cameraFrame}>
            <CameraView
              style={StyleSheet.absoluteFill}
              barcodeScannerSettings={{ barcodeTypes: ['code128', 'qr'] }}
              onBarcodeScanned={({ data }) => handleBarcode(String(data || ''))}
            />
            <View style={styles.scanGuide} />
          </View>
          <Text style={styles.scannerHint}>Accepted identity: LBL:&lt;batch/print id&gt;</Text>
        </SafeAreaView>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: BG },
  header: { paddingHorizontal: 18, paddingTop: 12, paddingBottom: 12, backgroundColor: '#FFF', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderBottomWidth: 1, borderBottomColor: BORDER },
  appName: { color: INK, fontSize: 20, fontWeight: '800' },
  headerSub: { color: MUTED, marginTop: 2, fontSize: 12 },
  betaPill: { backgroundColor: '#FFF5D6', paddingHorizontal: 10, paddingVertical: 5, borderRadius: 999 },
  betaPillText: { color: '#8A5B00', fontSize: 11, fontWeight: '800' },
  tabs: { flexDirection: 'row', backgroundColor: '#FFF', paddingHorizontal: 10, borderBottomWidth: 1, borderBottomColor: BORDER },
  tab: { flex: 1, paddingVertical: 12, alignItems: 'center', borderBottomWidth: 3, borderBottomColor: 'transparent' },
  tabActive: { borderBottomColor: PRIMARY },
  tabText: { color: MUTED, fontSize: 13, fontWeight: '700' },
  tabTextActive: { color: INK },
  content: { padding: 14, paddingBottom: 44, gap: 12 },
  betaBanner: { backgroundColor: '#FFF7DF', borderRadius: 14, padding: 14, borderWidth: 1, borderColor: '#F5D77A' },
  betaTitle: { color: '#714C00', fontSize: 12, fontWeight: '900', letterSpacing: 0.5 },
  betaBody: { color: '#714C00', marginTop: 5, fontSize: 12, lineHeight: 17 },
  section: { backgroundColor: '#FFF', borderRadius: 16, padding: 14, gap: 10, borderWidth: 1, borderColor: BORDER },
  sectionTitle: { fontSize: 14, fontWeight: '800', color: INK, marginBottom: 2 },
  choice: { minHeight: 54, borderWidth: 1, borderColor: BORDER, borderRadius: 12, paddingHorizontal: 13, paddingVertical: 10, flexDirection: 'row', alignItems: 'center', backgroundColor: '#FFF' },
  choiceSelected: { borderColor: PRIMARY, backgroundColor: '#FFF9E8' },
  choiceTitle: { color: INK, fontWeight: '750', fontSize: 14 },
  choiceSubtitle: { color: MUTED, fontSize: 12, marginTop: 3 },
  chevron: { color: INK, fontSize: 18, marginLeft: 8 },
  input: { borderWidth: 1, borderColor: BORDER, borderRadius: 12, minHeight: 48, paddingHorizontal: 12, fontSize: 15, color: INK, backgroundColor: '#FFF' },
  helper: { fontSize: 12, color: MUTED, lineHeight: 17 },
  helperCenter: { fontSize: 11, color: MUTED, lineHeight: 16, textAlign: 'center' },
  label: { fontSize: 12, fontWeight: '700', color: MUTED, marginTop: 2 },
  scanButton: { backgroundColor: INK, minHeight: 50, borderRadius: 12, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 14 },
  scanButtonText: { color: '#FFF', fontSize: 14, fontWeight: '800' },
  secondaryButton: { minHeight: 46, borderRadius: 12, borderWidth: 1, borderColor: INK, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 14 },
  secondaryText: { color: INK, fontWeight: '800', fontSize: 13 },
  primaryButton: { minHeight: 54, borderRadius: 13, backgroundColor: PRIMARY, alignItems: 'center', justifyContent: 'center', marginTop: 6 },
  primaryText: { color: '#111', fontWeight: '900', fontSize: 15 },
  or: { textAlign: 'center', color: MUTED, fontSize: 10, fontWeight: '800', letterSpacing: 1.2 },
  batchCard: { borderRadius: 14, borderWidth: 1, borderColor: BORDER, padding: 12, backgroundColor: '#FCFCFC', gap: 8 },
  batchHeader: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  batchProduct: { color: INK, fontWeight: '850', fontSize: 15 },
  batchAction: { color: MUTED, marginTop: 3, fontSize: 12 },
  statusPill: { borderRadius: 999, paddingHorizontal: 8, paddingVertical: 4 },
  statusGood: { backgroundColor: '#E8F6EF' },
  statusBad: { backgroundColor: '#FDEAE5' },
  statusText: { fontSize: 9, fontWeight: '900' },
  metricRow: { flexDirection: 'row', gap: 8 },
  metric: { flex: 1, backgroundColor: '#FFF', borderRadius: 10, padding: 9, borderWidth: 1, borderColor: '#ECEDEF' },
  metricLabel: { fontSize: 9, color: MUTED, fontWeight: '800' },
  metricValue: { marginTop: 3, color: INK, fontSize: 12, fontWeight: '750' },
  detail: { color: MUTED, fontSize: 11 },
  warningBox: { borderRadius: 12, padding: 12, backgroundColor: '#FFF2ED', borderWidth: 1, borderColor: '#F8C8B7' },
  warningTitle: { color: BAD, fontWeight: '850', fontSize: 13 },
  warningText: { color: BAD, fontSize: 12, marginTop: 3, lineHeight: 17 },
  reviewRow: { flexDirection: 'row', justifyContent: 'space-between', gap: 12, paddingVertical: 3 },
  reviewKey: { color: MUTED, fontSize: 12 },
  reviewValue: { color: INK, fontSize: 12, fontWeight: '750', flex: 1, textAlign: 'right' },
  hero: { backgroundColor: '#FFF', borderRadius: 16, padding: 16, borderWidth: 1, borderColor: BORDER, gap: 10 },
  heroTitle: { color: INK, fontSize: 22, fontWeight: '850' },
  heroBody: { color: MUTED, fontSize: 13, lineHeight: 19, marginBottom: 4 },
  statusLine: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  statusDot: { color: GOOD, fontSize: 14 },
  statusLineText: { color: INK, fontSize: 13, fontWeight: '650' },
  scannerPage: { flex: 1, backgroundColor: '#111' },
  scannerTop: { backgroundColor: '#FFF', paddingHorizontal: 16, paddingVertical: 14, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  scannerTitle: { color: INK, fontSize: 18, fontWeight: '850' },
  scannerSub: { color: MUTED, fontSize: 11, marginTop: 2 },
  close: { color: INK, fontSize: 14, fontWeight: '800' },
  cameraFrame: { flex: 1, overflow: 'hidden' },
  scanGuide: { position: 'absolute', left: '10%', right: '10%', top: '38%', height: 160, borderWidth: 3, borderColor: PRIMARY, borderRadius: 18 },
  scannerHint: { color: '#FFF', padding: 16, textAlign: 'center', fontSize: 12 },
});
