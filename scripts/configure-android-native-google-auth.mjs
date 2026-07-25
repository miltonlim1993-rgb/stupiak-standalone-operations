import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const root = process.cwd()
const androidRoot = path.join(root, 'web', 'android')
const appGradlePath = path.join(androidRoot, 'app', 'build.gradle')
const javaRoot = path.join(androidRoot, 'app', 'src', 'main', 'java', 'com', 'stupiaks', 'ops')
const mainActivityPath = path.join(javaRoot, 'MainActivity.java')
const pluginPath = path.join(javaRoot, 'NativeGoogleAuthPlugin.java')

await fs.mkdir(javaRoot, { recursive: true })

let gradle = await fs.readFile(appGradlePath, 'utf8')
const marker = '// stupiaksNativeGoogleAuthDependencies'
if (!gradle.includes(marker)) {
  const dependenciesOpen = /dependencies\s*\{/m
  if (!dependenciesOpen.test(gradle)) throw new Error('Unable to find dependencies block in app/build.gradle')
  gradle = gradle.replace(dependenciesOpen, `dependencies {\n    ${marker}\n    implementation "androidx.credentials:credentials:1.6.0"\n    implementation "androidx.credentials:credentials-play-services-auth:1.6.0"\n    implementation "com.google.android.libraries.identity.googleid:googleid:1.1.1"`)
  await fs.writeFile(appGradlePath, gradle)
}

await fs.writeFile(mainActivityPath, `package com.stupiaks.ops;

import android.os.Bundle;
import android.webkit.CookieManager;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(NativeGoogleAuthPlugin.class);
        super.onCreate(savedInstanceState);

        CookieManager cookieManager = CookieManager.getInstance();
        cookieManager.setAcceptCookie(true);
        cookieManager.setAcceptThirdPartyCookies(getBridge().getWebView(), true);
    }
}
`)

await fs.writeFile(pluginPath, `package com.stupiaks.ops;

import android.os.CancellationSignal;

import androidx.annotation.NonNull;
import androidx.core.content.ContextCompat;
import androidx.credentials.Credential;
import androidx.credentials.CredentialManager;
import androidx.credentials.CredentialManagerCallback;
import androidx.credentials.CustomCredential;
import androidx.credentials.GetCredentialRequest;
import androidx.credentials.GetCredentialResponse;
import androidx.credentials.exceptions.GetCredentialCancellationException;
import androidx.credentials.exceptions.GetCredentialException;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.android.libraries.identity.googleid.GetSignInWithGoogleOption;
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential;

@CapacitorPlugin(name = "NativeGoogleAuth")
public class NativeGoogleAuthPlugin extends Plugin {
    private CredentialManager credentialManager;

    @Override
    public void load() {
        credentialManager = CredentialManager.create(getActivity());
    }

    @PluginMethod
    public void signIn(PluginCall call) {
        String serverClientId = call.getString("serverClientId");
        if (serverClientId == null || serverClientId.trim().isEmpty()) {
            call.reject("Google Web Client ID is missing");
            return;
        }

        GetSignInWithGoogleOption googleOption = new GetSignInWithGoogleOption.Builder(serverClientId.trim()).build();
        GetCredentialRequest request = new GetCredentialRequest.Builder()
            .addCredentialOption(googleOption)
            .build();

        credentialManager.getCredentialAsync(
            getActivity(),
            request,
            new CancellationSignal(),
            ContextCompat.getMainExecutor(getActivity()),
            new CredentialManagerCallback<GetCredentialResponse, GetCredentialException>() {
                @Override
                public void onResult(@NonNull GetCredentialResponse result) {
                    try {
                        Credential credential = result.getCredential();
                        if (!(credential instanceof CustomCredential)) {
                            call.reject("Google returned an unsupported credential type");
                            return;
                        }

                        CustomCredential customCredential = (CustomCredential) credential;
                        if (!GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL.equals(customCredential.getType())) {
                            call.reject("Google returned an unexpected credential type");
                            return;
                        }

                        GoogleIdTokenCredential googleCredential = GoogleIdTokenCredential.createFrom(customCredential.getData());
                        JSObject response = new JSObject();
                        response.put("idToken", googleCredential.getIdToken());
                        call.resolve(response);
                    } catch (Exception error) {
                        call.reject(error.getMessage() == null ? "Unable to parse Google sign-in result" : error.getMessage());
                    }
                }

                @Override
                public void onError(@NonNull GetCredentialException error) {
                    if (error instanceof GetCredentialCancellationException) {
                        call.reject("Google sign-in was cancelled");
                    } else {
                        String message = error.getMessage();
                        call.reject(message == null || message.isBlank() ? "Native Google sign-in failed" : message);
                    }
                }
            }
        );
    }
}
`)

console.log('Configured Android Credential Manager Google sign-in bridge.')
