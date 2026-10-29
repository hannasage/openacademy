import XCTest

final class ReadingUITests: XCTestCase {
    private func openLibrary(_ app: XCUIApplication) {
        let toggle = app.buttons["ToggleSidebar"]
        if toggle.waitForExistence(timeout: 2), !app.buttons["course-reading-one-downloaded"].isHittable { toggle.tap() }
    }
    func testTwoOfflineCopiesKeepLessonAndSourceNavigation() {
        let app = XCUIApplication()
        app.launchArguments = ["--touchline-ui-test", "--touchline-ui-test-reading"]
        app.launch()
        openLibrary(app)
        let first = app.buttons["course-reading-one-downloaded"]
        XCTAssertTrue(first.waitForExistence(timeout: 15))
        XCTAssertTrue(first.label.hasPrefix("Soccer forecasts"))
        XCTAssertTrue(first.label.contains("modules complete"))
        let library = XCTAttachment(screenshot: app.screenshot()); library.name = "P12 library"; library.lifetime = .keepAlways; add(library)
        first.tap()
        let resume = app.buttons["continue-reading"]
        XCTAssertTrue(resume.waitForExistence(timeout: 5)); resume.tap()
        let sources = app.buttons["read-sources"]
        for _ in 0..<8 { if sources.isHittable { break }; app.swipeUp() }
        XCTAssertTrue(sources.isHittable); sources.tap()
        let source = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'source-' ")).firstMatch
        for _ in 0..<6 { if source.isHittable { break }; app.swipeUp() }
        XCTAssertTrue(source.isHittable); source.tap()
        let error = app.staticTexts["source-error"]
        for _ in 0..<3 { if error.isHittable { break }; app.swipeUp() }
        XCTAssertTrue(error.exists)
        let sourceShot = XCTAttachment(screenshot: app.screenshot()); sourceShot.name = "P12 source failure"; sourceShot.lifetime = .keepAlways; add(sourceShot)
        app.navigationBars["Read & explore"].buttons.element(boundBy: 0).tap()
        let offline = app.buttons["offline-lesson"]
        XCTAssertTrue(offline.waitForExistence(timeout: 5))
        let lesson = XCTAttachment(screenshot: app.screenshot()); lesson.name = "P12 lesson"; lesson.lifetime = .keepAlways; add(lesson)
        offline.tap()
        XCTAssertTrue(app.staticTexts["Keep reading."].waitForExistence(timeout: 5))
        let saved = XCTAttachment(screenshot: app.screenshot()); saved.name = "P12 offline lesson"; saved.lifetime = .keepAlways; add(saved)
        app.navigationBars["Downloaded lesson"].buttons.element(boundBy: 0).tap()
        app.navigationBars["Start with a forecast"].buttons.element(boundBy: 0).tap()
        if app.buttons["ToggleSidebar"].exists { app.buttons["ToggleSidebar"].tap() }
        else { app.navigationBars["Curriculum"].buttons.element(boundBy: 0).tap() }
        let second = app.buttons["course-reading-two-downloaded"]
        for _ in 0..<5 { if second.isHittable { break }; app.swipeUp() }
        XCTAssertTrue(second.isHittable); second.tap()
        let secondResume = app.buttons["continue-reading"]
        for _ in 0..<5 { if secondResume.isHittable { break }; app.swipeUp() }
        XCTAssertTrue(secondResume.isHittable); secondResume.tap()
        let secondNotes = app.staticTexts["Second course notes"]
        for _ in 0..<10 { if secondNotes.isHittable { break }; app.swipeUp() }
        XCTAssertTrue(secondNotes.exists)
        XCTAssertFalse(app.staticTexts["First course notes"].exists)
    }
    func testLibrarySupportsAccessibilityTextAndLongTitles() {
        let app = XCUIApplication()
        app.launchArguments = ["--touchline-ui-test", "--touchline-ui-test-reading", "-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"]
        app.launch()
        openLibrary(app)
        let first = app.buttons["course-reading-one-downloaded"]
        XCTAssertTrue(first.waitForExistence(timeout: 15))
        for _ in 0..<5 { if first.isHittable { break }; app.swipeUp() }
        XCTAssertTrue(first.isHittable)
        let shot = XCTAttachment(screenshot: app.screenshot()); shot.name = "P12 accessibility library"; shot.lifetime = .keepAlways; add(shot)
        first.tap()
        let resume = app.buttons["continue-reading"]
        for _ in 0..<10 { if resume.isHittable { break }; app.swipeUp() }
        XCTAssertTrue(resume.isHittable)
        resume.tap()
        XCTAssertTrue(app.navigationBars.count > 0)
    }
    func testFailedSignOutOffersReachableRetry() {
        let app = XCUIApplication()
        app.launchArguments = ["--touchline-ui-test", "--touchline-ui-test-signout-retry"]
        app.launch()
        if app.buttons["ToggleSidebar"].waitForExistence(timeout: 2), !app.staticTexts["Soccer → machine learning"].exists { app.buttons["ToggleSidebar"].tap() }
        let backend = app.buttons["Backend and account"]
        XCTAssertTrue(backend.waitForExistence(timeout: 15))
        backend.tap()
        let signOut = app.buttons["sign-out"]
        XCTAssertTrue(signOut.waitForExistence(timeout: 5))
        if !signOut.isHittable { app.swipeUp() }
        signOut.tap()
        let retry = app.buttons["Retry sign-out and cleanup"]
        XCTAssertTrue(retry.waitForExistence(timeout: 5))
        XCTAssertTrue(retry.isHittable)
        retry.tap()
        XCTAssertTrue(signOut.waitForNonExistence(timeout: 5))
    }
    func testBundledLibraryLaunchesOfflineAndRelaunches() {
        let app = XCUIApplication()
        app.launchArguments = ["--touchline-ui-test"]
        app.launch()
        if app.buttons["ToggleSidebar"].waitForExistence(timeout: 2), !app.staticTexts["Soccer → machine learning"].exists { app.buttons["ToggleSidebar"].tap() }
        XCTAssertTrue(app.staticTexts["Soccer → machine learning"].waitForExistence(timeout: 15))
        XCTAssertTrue(app.buttons["Backend and account"].exists)
        app.terminate()
        app.launch()
        if app.buttons["ToggleSidebar"].waitForExistence(timeout: 2), !app.staticTexts["Soccer → machine learning"].exists { app.buttons["ToggleSidebar"].tap() }
        XCTAssertTrue(app.staticTexts["Soccer → machine learning"].waitForExistence(timeout: 15))
    }
}

final class ConnectionUITests: XCTestCase {
    private func launch(largeText: Bool = false) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--touchline-ui-test", "--touchline-ui-test-connection"]
        app.launchEnvironment["TOUCHLINE_APPEARANCE_TEST_SUITE"] = UUID().uuidString
        if largeText { app.launchArguments += ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"] }
        app.launch()
        let devices = app.buttons["Devices"].firstMatch
        XCTAssertTrue(devices.waitForExistence(timeout: 15)); devices.tap()
        let account = app.buttons["Backend and account"].firstMatch
        reveal(account, app: app)
        XCTAssertTrue(account.waitForExistence(timeout: 10)); account.tap()
        return app
    }
    private func reveal(_ element: XCUIElement, app: XCUIApplication) {
        for _ in 0..<12 {
            if element.isHittable { return }
            let scroll = app.scrollViews.firstMatch
            let collection = app.collectionViews.firstMatch
            let table = app.tables.firstMatch
            if scroll.exists { scroll.swipeUp() }
            else if collection.exists { collection.swipeUp() }
            else if table.exists { table.swipeUp() }
            else { app.swipeUp() }
        }
    }
    private func shot(_ name: String, app: XCUIApplication) {
        let attachment = XCTAttachment(screenshot: app.screenshot()); attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
    }
    private func connect(_ app: XCUIApplication) {
        let address = app.textFields["Hub address"]
        reveal(address, app: app); address.tap(); address.typeText("https://learn.example.org")
        let find = app.buttons["Find my hub"]; reveal(find, app: app); find.tap()
        let use = app.buttons["Use this hub"]; XCTAssertTrue(use.waitForExistence(timeout: 5)); reveal(use, app: app)
        shot("P14 hub review", app: app); use.tap()
        let email = app.textFields["Email"]; XCTAssertTrue(email.waitForExistence(timeout: 5)); reveal(email, app: app)
        shot("P14 email sign-in", app: app); email.tap(); email.typeText("fixture@example.org")
        let send = app.buttons["Email me a sign-in code"]; reveal(send, app: app); send.tap()
    }
    func testReviewCodeAndSelectedOfflineDownloads() {
        let app = launch(); shot("P14 find hub", app: app); connect(app)
        let code = app.textFields["Sign-in code"]; XCTAssertTrue(code.waitForExistence(timeout: 5)); reveal(code, app: app)
        shot("P14 enter code", app: app); code.tap(); code.typeText("123456")
        let verify = app.buttons["Verify & continue"]; reveal(verify, app: app); verify.tap()
        let soccer = app.switches["download-choice-soccer"]
        XCTAssertTrue(soccer.waitForExistence(timeout: 5)); XCTAssertEqual(soccer.value as? String, "1")
        let shaders = app.switches["download-choice-shaders"]; reveal(shaders, app: app); shaders.tap()
        shot("P14 choose downloads", app: app)
        let download = app.buttons["Download selected · 2"]; reveal(download, app: app); download.tap()
        let message = app.staticTexts["connection-message"]
        XCTAssertTrue(message.waitForExistence(timeout: 5))
        XCTAssertTrue(message.label.contains("Downloaded 2 curricula"))
        app.navigationBars.buttons["Done"].tap()
        let devices = app.buttons["Devices"].firstMatch; XCTAssertTrue(devices.exists); devices.tap()
        XCTAssertTrue(app.staticTexts["Creative coding with shaders"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.staticTexts["Photography fundamentals"].exists)
        shot("P14 saved downloads", app: app)
    }
    func testAppearancePreservesConnectedSelectionsAndSavedCopies() {
        let originalAppearance = XCUIDevice.shared.appearance
        defer { XCUIDevice.shared.appearance = originalAppearance == .unspecified ? .light : originalAppearance }
        XCUIDevice.shared.appearance = .dark
        let app = launch(); connect(app)
        let code = app.textFields["Sign-in code"]
        XCTAssertTrue(code.waitForExistence(timeout: 5)); reveal(code, app: app); code.tap(); code.typeText("123456")
        let verify = app.buttons["Verify & continue"]; reveal(verify, app: app); verify.tap()
        let shaders = app.switches["download-choice-shaders"]
        XCTAssertTrue(shaders.waitForExistence(timeout: 5)); reveal(shaders, app: app); shaders.tap()
        func changeAppearance(_ pair: String, _ mode: String, _ name: String) {
            app.navigationBars.buttons["Done"].tap()
            let trigger = app.buttons["appearance-trigger"].firstMatch
            XCTAssertTrue(trigger.waitForExistence(timeout: 5)); trigger.tap()
            let choice = app.buttons["appearance-pair-" + pair]
            XCTAssertTrue(choice.waitForExistence(timeout: 5)); choice.tap()
            app.buttons["appearance-mode-" + mode].tap()
            XCTAssertEqual(app.staticTexts["appearance-current"].label, name)
            app.buttons["appearance-done"].tap()
            let account = app.buttons["Backend and account"].firstMatch
            reveal(account, app: app); account.tap()
        }
        func captureContinueReading(_ name: String) {
            app.buttons["Library"].firstMatch.tap()
            let resume = app.buttons["continue-reading"]
            if !resume.waitForExistence(timeout: 2) {
                let course = app.buttons["course-soccer-downloaded"]
                if !course.isHittable, app.buttons["ToggleSidebar"].exists { app.buttons["ToggleSidebar"].tap() }
                XCTAssertTrue(course.waitForExistence(timeout: 5)); reveal(course, app: app); course.tap()
            }
            reveal(resume, app: app); XCTAssertTrue(resume.isHittable)
            shot(name + " Continue reading", app: app); resume.tap()
            XCTAssertTrue(app.navigationBars["Start with a forecast"].waitForExistence(timeout: 5))
            app.navigationBars["Start with a forecast"].buttons.element(boundBy: 0).tap()
            app.buttons["Devices"].firstMatch.tap()
        }
        changeAppearance("coast", "light", "Coastal Day")
        for id in ["soccer", "shaders"] {
            let choice = app.switches["download-choice-" + id]
            XCTAssertTrue(choice.waitForExistence(timeout: 5)); XCTAssertEqual(choice.value as? String, "1")
        }
        shot("Joined Coastal Day selected curricula", app: app)
        let download = app.buttons["Download selected · 2"]; reveal(download, app: app); download.tap()
        let message = app.staticTexts["connection-message"]
        XCTAssertTrue(message.waitForExistence(timeout: 5)); XCTAssertTrue(message.label.contains("Downloaded 2 curricula"))
        app.navigationBars.buttons["Done"].tap()
        shot("Joined Coastal Day saved curricula", app: app)
        captureContinueReading("Joined Coastal Day")
        let account = app.buttons["Backend and account"].firstMatch; reveal(account, app: app); account.tap()
        changeAppearance("bloom", "dark", "Noir Bloom")
        XCTAssertEqual(app.buttons.matching(identifier: "Remove download").count, 2)
        app.navigationBars.buttons["Done"].tap()
        for title in ["Soccer → machine learning", "Creative coding with shaders"] {
            XCTAssertTrue(app.staticTexts[title].waitForExistence(timeout: 5))
        }
        XCTAssertFalse(app.staticTexts["Photography fundamentals"].exists)
        shot("Joined Noir Bloom saved curricula", app: app)
        captureContinueReading("Joined Noir Bloom")
    }
    func testDeniedCameraAndCancelledReviewKeepLocalLibrary() {
        let app = launch()
        let scan = app.buttons["Scan hub QR code"]; XCTAssertTrue(scan.waitForExistence(timeout: 5)); scan.tap()
        XCTAssertTrue(app.staticTexts["camera-message"].waitForExistence(timeout: 5))
        let address = app.textFields["Hub address"]; reveal(address, app: app); address.tap(); address.typeText("https://learn.example.org")
        let find = app.buttons["Find my hub"]; reveal(find, app: app); find.tap()
        let cancel = app.buttons["Cancel"]; XCTAssertTrue(cancel.waitForExistence(timeout: 5)); reveal(cancel, app: app); cancel.tap()
        XCTAssertTrue(app.buttons["Find my hub"].exists)
        app.navigationBars.buttons["Done"].tap()
        XCTAssertTrue(app.buttons["Backend and account"].waitForExistence(timeout: 5))
    }
    func testOfflineSavedCopyCanBeRemovedWithoutLoadingCatalog() {
        let app = XCUIApplication()
        app.launchArguments = ["--touchline-ui-test", "--touchline-ui-test-reading"]
        app.launch()
        let devices = app.buttons["Devices"].firstMatch
        XCTAssertTrue(devices.waitForExistence(timeout: 15)); devices.tap()
        let account = app.buttons["Backend and account"].firstMatch; reveal(account, app: app); account.tap()
        let remove = app.buttons["remove-download-reading-one"]
        XCTAssertTrue(remove.waitForExistence(timeout: 5)); reveal(remove, app: app); remove.tap()
        XCTAssertFalse(remove.exists)
        let other = app.buttons["remove-download-reading-two"]
        XCTAssertTrue(other.exists)
        shot("P14 offline download removal", app: app)
    }
    func testConnectionRemainsScrollableWithAccessibilityText() {
        let app = launch(largeText: true)
        let find = app.buttons["Find my hub"]; reveal(find, app: app); XCTAssertTrue(find.isHittable)
        shot("P14 accessible connection", app: app)
        app.navigationBars.buttons["Done"].tap()
    }
}
